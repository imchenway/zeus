import Accelerate
import CoreAudio
import Foundation

/// Core Audio reports failures as OSStatus values.
private struct AudioCaptureError: Error {
    let status: OSStatus
}

/// Stop setup at the first failed Core Audio operation.
private func check(_ status: OSStatus) throws {
    if status != noErr { throw AudioCaptureError(status: status) }
}

/// Buffer only the most recent input window for the spectrum calculation.
private final class AudioSpectrum {
    static let size = 4096

    private let lock = NSLock()
    private var ring = [Float](repeating: 0, count: size)
    private var head = 0
    private var hasInput = false

    private let sampleRate: Double
    private let transform: vDSP_DFT_Setup
    private var samples = [Float](repeating: 0, count: size)
    private var window = [Float](repeating: 0, count: size)
    private let zeros = [Float](repeating: 0, count: size)
    private var real = [Float](repeating: 0, count: size)
    private var imaginary = [Float](repeating: 0, count: size)
    private var powers: [Float]
    private var sentSilence = false
    // Some output devices deliver buffers less often than the 32 ms display interval.
    private var emptyIntervals = 0

    /// Allocate the transform buffers once, outside the capture callback.
    init(sampleRate: Double) throws {
        guard let transform = vDSP_DFT_zop_CreateSetup(nil, vDSP_Length(Self.size), .FORWARD) else {
            throw AudioCaptureError(status: kAudioHardwareUnspecifiedError)
        }
        self.transform = transform
        self.sampleRate = sampleRate
        let bins = min(Self.size / 2, Int(ceil(12_000 * Double(Self.size) / sampleRate)))
        powers = [Float](repeating: 0, count: bins)
        vDSP_hann_window(&window, vDSP_Length(Self.size), Int32(vDSP_HANN_NORM))
    }

    deinit {
        vDSP_DFT_DestroySetup(transform)
    }

    /// Copy mono samples without waiting on the non-realtime spectrum worker.
    func append(_ input: UnsafePointer<AudioBufferList>) {
        let buffer = input.pointee.mBuffers
        guard let data = buffer.mData, lock.try() else { return }
        defer { lock.unlock() }
        let source = data.assumingMemoryBound(to: Float.self)
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.stride
        guard count > 0 else { return }
        for index in max(0, count - Self.size)..<count {
            ring[head] = source[index]
            head = (head + 1) % Self.size
        }
        hasInput = true
    }

    /// Send magnitude-squared FFT bins and RMS. Raw PCM stays in the helper.
    func publish() {
        lock.lock()
        let received = hasInput
        if received {
            for index in samples.indices {
                samples[index] = ring[(head + index) % Self.size]
            }
            hasInput = false
        }
        lock.unlock()

        var rms: Float = 0
        if received {
            emptyIntervals = 0
            vDSP_rmsqv(samples, 1, &rms, vDSP_Length(Self.size))
        } else if emptyIntervals < 4 {
            emptyIntervals += 1
            return
        }
        if rms.isFinite && rms > 0.008 {
            vDSP_vmul(samples, 1, window, 1, &samples, 1, vDSP_Length(Self.size))
            vDSP_DFT_Execute(transform, samples, zeros, &real, &imaginary)
            for index in powers.indices {
                powers[index] = real[index] * real[index] + imaginary[index] * imaginary[index]
            }
            sentSilence = false
        } else {
            guard !sentSilence else { return }
            rms = 0
            powers = [Float](repeating: 0, count: powers.count)
            sentSilence = true
        }
        let encoded = powers.withUnsafeBytes { Data($0).base64EncodedString() }
        let line = "\(sampleRate / Double(Self.size)) \(rms) \(encoded)\n"
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}

/// Capture the system playback mix without changing its route or mute state.
@available(macOS 14.2, *)
private func capture() throws {
    let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
    description.name = "Zeus Conversation Audio"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    var tap = AudioObjectID(kAudioObjectUnknown)
    try check(AudioHardwareCreateProcessTap(description, &tap))
    defer { AudioHardwareDestroyProcessTap(tap) }

    var formatAddress = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var format = AudioStreamBasicDescription()
    var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &formatSize, &format))
    guard format.mSampleRate.isFinite, format.mSampleRate > 0,
          format.mFormatID == kAudioFormatLinearPCM,
          format.mChannelsPerFrame == 1, format.mBitsPerChannel == 32,
          format.mFormatFlags & kAudioFormatFlagIsFloat != 0 else {
        throw AudioCaptureError(status: kAudioHardwareUnsupportedOperationError)
    }
    let spectrum = try AudioSpectrum(sampleRate: format.mSampleRate)

    // This private input device contains only the tap and is never set as a system device.
    let configuration: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Zeus Conversation Audio",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString]],
    ]
    var device = AudioObjectID(kAudioObjectUnknown)
    try check(AudioHardwareCreateAggregateDevice(configuration as CFDictionary, &device))
    defer { AudioHardwareDestroyAggregateDevice(device) }

    var ioProc: AudioDeviceIOProcID?
    try check(AudioDeviceCreateIOProcIDWithBlock(&ioProc, device, nil) { _, input, _, _, _ in
        spectrum.append(input)
    })
    guard let ioProc else { throw AudioCaptureError(status: kAudioHardwareUnspecifiedError) }
    defer { AudioDeviceDestroyIOProcID(device, ioProc) }
    try check(AudioDeviceStart(device, ioProc))
    defer { AudioDeviceStop(device, ioProc) }

    // The pipe stays open while the owning Zeus process has a visible subscriber.
    let queue = DispatchQueue(label: "dev.hypha.zeus.conversation-audio")
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(32), leeway: .milliseconds(4))
    timer.setEventHandler { spectrum.publish() }
    timer.resume()
    _ = FileHandle.standardInput.readDataToEndOfFile()
    queue.sync { timer.cancel() }
}

/// A closed parent pipe ends capture, including when Zeus exits unexpectedly.
@main
private enum ConversationAudio {
    static func main() {
        guard #available(macOS 14.2, *) else { exit(EXIT_FAILURE) }
        do {
            try capture()
        } catch {
            exit(EXIT_FAILURE)
        }
    }
}
