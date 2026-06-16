#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf "$ROOT/.tmp"
mkdir -p "$ROOT/.tmp"
pnpm build
node packages/code-indexer/dist/cli.js scan --path "$ROOT" --project-name Zeus --db "$ROOT/.tmp/zeus-real-scan.db"
node packages/graph-engine/dist/cli.js generate-views --db "$ROOT/.tmp/zeus-real-scan.db" --project Zeus
node packages/graph-engine/dist/cli.js assert-nonempty --db "$ROOT/.tmp/zeus-real-scan.db" --project Zeus
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const db = new SQL.Database(await readFile(`${process.cwd()}/.tmp/zeus-real-scan.db`));
const loopBackCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'loop_back'")[0]?.values[0]?.[0] ?? 0;
const loopContinueCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'loop_continue'")[0]?.values[0]?.[0] ?? 0;
const loopBreakCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'loop_break'")[0]?.values[0]?.[0] ?? 0;
const tryCatchCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'try_catch'")[0]?.values[0]?.[0] ?? 0;
const tryFinallyCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'try_finally'")[0]?.values[0]?.[0] ?? 0;
const promiseCatchCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'promise_catch'")[0]?.values[0]?.[0] ?? 0;
const promiseThenCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'promise_then'")[0]?.values[0]?.[0] ?? 0;
const awaitsCallCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'awaits_call'")[0]?.values[0]?.[0] ?? 0;
const usesColumnCount = db.exec("SELECT COUNT(*) AS count FROM project_edges WHERE project_name = 'Zeus' AND edge_type = 'uses_column'")[0]?.values[0]?.[0] ?? 0;
const methodLogicPayload = db.exec("SELECT payload_json FROM graph_views WHERE project_name = 'Zeus' AND view_type = 'method_logic'")[0]?.values[0]?.[0];
if (!methodLogicPayload || Number(loopBackCount) <= 0 || Number(loopContinueCount) <= 0 || Number(loopBreakCount) <= 0 || Number(tryCatchCount) <= 0 || Number(tryFinallyCount) <= 0 || Number(promiseCatchCount) <= 0 || Number(promiseThenCount) <= 0 || Number(awaitsCallCount) <= 0 || Number(usesColumnCount) <= 0) {
  throw new Error(`Zeus real-scan method logic edge assertion failed: loopBackCount=${loopBackCount} loopContinueCount=${loopContinueCount} loopBreakCount=${loopBreakCount} tryCatchCount=${tryCatchCount} tryFinallyCount=${tryFinallyCount} promiseCatchCount=${promiseCatchCount} promiseThenCount=${promiseThenCount} awaitsCallCount=${awaitsCallCount} usesColumnCount=${usesColumnCount}`);
}
const edgeIds = JSON.parse(String(methodLogicPayload)).edgeIds;
const placeholders = edgeIds.map(() => '?').join(',');
const methodLogicLoopBackCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'loop_back' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicLoopContinueCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'loop_continue' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicLoopBreakCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'loop_break' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicTryCatchCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'try_catch' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicTryFinallyCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'try_finally' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicPromiseCatchCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'promise_catch' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicPromiseThenCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'promise_then' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicAwaitsCallCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'awaits_call' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
const methodLogicUsesColumnCount = db.exec(`SELECT COUNT(*) AS count FROM project_edges WHERE edge_type = 'uses_column' AND id IN (${placeholders})`, edgeIds)[0]?.values[0]?.[0] ?? 0;
if (Number(methodLogicLoopBackCount) <= 0 || Number(methodLogicLoopContinueCount) <= 0 || Number(methodLogicLoopBreakCount) <= 0 || Number(methodLogicTryCatchCount) <= 0 || Number(methodLogicTryFinallyCount) <= 0 || Number(methodLogicPromiseCatchCount) <= 0 || Number(methodLogicPromiseThenCount) <= 0 || Number(methodLogicAwaitsCallCount) <= 0 || Number(methodLogicUsesColumnCount) <= 0) {
  throw new Error(`Zeus method_logic view is missing expected edges: loopBack=${methodLogicLoopBackCount} loopContinue=${methodLogicLoopContinueCount} loopBreak=${methodLogicLoopBreakCount} tryCatch=${methodLogicTryCatchCount} tryFinally=${methodLogicTryFinallyCount} promiseCatch=${methodLogicPromiseCatchCount} promiseThen=${methodLogicPromiseThenCount} awaitsCall=${methodLogicAwaitsCallCount} usesColumn=${methodLogicUsesColumnCount}`);
}
NODE
