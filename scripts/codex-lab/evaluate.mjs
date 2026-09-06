// Post-inference only: no model calls, and no reference access until all six runs exist.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] ?? '../evidence/CODEX-IA-r2');
const corpus = resolve('../evidence/V1P/products-v1-r2');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const ids = process.argv.length > 3 ? process.argv.slice(3) : ['FP1-001-A','FP1-002-B','FP1-023-A','FP1-024-B','FP1-037-A','FP1-040-B'];
const calls = await Promise.all((await readdir(join(root,'calls'))).map(async id => ({
  folder: join(root,'calls',id), metrics: await read(join(root,'calls',id,'metrics.json')),
  plan: await read(join(root,'calls',id,'response.json')),
  request: await read(join(root,'calls',id,'request.json')),
})));
if (calls.length !== ids.length || calls.some(c => c.metrics.failure || c.metrics.exit_code !== 0 || !c.metrics.usage))
  throw new Error('All selected calls must complete before opening answer key');
const browser = await Promise.all(ids.map(async id => {
  const folder=join(root,'browser',id);
  return { id, source:await read(join(folder,'source.json')), state:await read(join(folder,'final-state.json')),
    request:await read(join(folder,'request.json')), plan:await read(join(folder,'response.json')) };
}));
const keyBytes = await readFile(join(corpus,'reviewer/answer-key.json'));
const key = JSON.parse(keyBytes);
const result = { evaluatedAt:new Date().toISOString(), referenceOpenedAfterAllInferences:true,
  answerKeySha256:createHash('sha256').update(keyBytes).digest('hex'),
  scope:'Synthetic automated cases; not a human study or commercial provider validation.',
  evaluationRole:ids.length===6?'initial fixed sample':'targeted regression after known mismatch; not a fresh blind sample',
  cases:[], fieldMatches:0, fields:0, actionMatches:0, actions:0, ignoredPreserved:0,
  cliAttemptsCompleted:ids.length, previousAbortedAttempts:2, previousAbortedUsage:null,
  usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0},
  externalApiSpendUsd:0, codexComputeCostUsd:null };
for (const row of browser) {
  const fieldRows = Object.entries(key[row.id].expected).map(([field,expected]) => {
    const fieldId = row.request.formSchema.fields.find(f=>f.name===field)?.id;
    const action = row.plan.fills.find(f=>f.fieldId===fieldId);
    const actionMatch = expected.action==='leave'
      ? !action || action.action==='skip'
      : action?.action==='set' && action.value===expected.value;
    return {field,expected:expected.value,actual:row.state[field],valueMatch:row.state[field]===expected.value,actionMatch};
  });
  const matching = calls.filter(c => JSON.stringify(c.plan)===JSON.stringify(row.plan));
  if (matching.length!==1) throw new Error('Cannot uniquely match browser result to raw CLI output');
  const call = matching[0];
  const all = fieldRows.filter(f=>f.field!=='manual-note');
  result.fields += all.length; result.fieldMatches += all.filter(f=>f.valueMatch).length;
  result.actions += all.length; result.actionMatches += all.filter(f=>f.actionMatch).length;
  result.ignoredPreserved += Number(fieldRows.find(f=>f.field==='manual-note').valueMatch);
  result.cases.push({id:row.id,callId:call.metrics.id,browserElapsedMs:row.source.elapsed_ms,
    cliElapsedMs:call.metrics.elapsed_ms,usage:call.metrics.usage,toolEvents:call.metrics.tool_events,fields:fieldRows});
}
for(const call of calls) for(const key of Object.keys(result.usage)) result.usage[key]+=call.metrics.usage[key]??0;
await writeFile(join(root,'evaluation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
