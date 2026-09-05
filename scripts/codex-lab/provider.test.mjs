import test from 'node:test';
import assert from 'node:assert/strict';
import { Admission, authorize, validateRequest, validatePlan, codexArgs, auditEvent, runProcess, childEnvironment } from './provider.mjs';

test('capability and same-host checks reject browser origins and missing tokens', () => {
  assert.throws(() => authorize({ headers: { host: '127.0.0.1:1' } }, 'secret', '127.0.0.1:1'));
  assert.throws(() => authorize({ headers: { host: '127.0.0.1:1', origin: 'http://evil.test', authorization: 'Bearer secret' } }, 'secret', '127.0.0.1:1'));
  assert.doesNotThrow(() => authorize({ headers: { host: '127.0.0.1:1', authorization: 'Bearer secret' } }, 'secret', '127.0.0.1:1'));
});
test('one outstanding request and six-call limit fail closed', () => {
  const admission = new Admission(), done = admission.acquire();
  assert.throws(() => admission.acquire(), /one Codex request/); done();
  for (let i = 1; i < 6; i++) admission.acquire()();
  assert.throws(() => admission.acquire(), /call limit/);
  const bounded = new Admission(2); bounded.acquire()(); bounded.acquire()();
  assert.throws(() => bounded.acquire(), /call limit/);
  assert.throws(() => new Admission(7));
  assert.throws(() => new Admission(0));
});
test('requests reject remote images, excessive text, unsupported roles and models', () => {
  const base = { model: 'codex-lab-gpt-6-astra', response_format: { type:'json_schema', json_schema:{ strict:true } }, messages:[{ role:'user', content:'product source' }] };
  assert.doesNotThrow(() => validateRequest(base));
  assert.throws(() => validateRequest({ ...base, model:'another-model' }));
  assert.throws(() => validateRequest({ ...base, messages:[{ role:'assistant', content:'bad' }] }));
  assert.throws(() => validateRequest({ ...base, messages:[{ role:'user', content:'x'.repeat(65537) }] }));
  assert.throws(() => validateRequest({ ...base, messages:[{ role:'user', content:[{ type:'image_url', image_url:{ url:'https://example.test/image.png' } }] }] }));
});
test('output must match the actual fill schema without duplicate IDs or extra keys', () => {
  assert.deepEqual(validatePlan({ fills:[{ fieldId:'ff-0',action:'skip',value:null }] }).fills[0].action, 'skip');
  assert.throws(() => validatePlan({ fills:[], script:'submit()' }));
  assert.throws(() => validatePlan({ fills:[{ fieldId:'ff-0',action:'execute',value:'rm' }] }));
  assert.throws(() => validatePlan({ fills:[{ fieldId:'ff-0',action:'skip',value:null },{ fieldId:'ff-0',action:'set',value:'x' }] }));
});
test('CLI is explicit read-only, no shell tools or user config, and no API-key inheritance', () => {
  const args = codexArgs('/tmp/input','/tmp/schema','/tmp/result',[]);
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ephemeral'));
  assert.equal(args[args.indexOf('--sandbox')+1], 'read-only');
  assert.equal(args[args.indexOf('-m')+1], 'gpt-6-astra');
  assert.ok(args.includes('shell_tool') && args.includes('plugins') && args.includes('web_search="disabled"'));
  assert.equal(childEnvironment().OPENAI_API_KEY, undefined);
  assert.equal(childEnvironment().FIELDFOX_LLM_API_KEY, undefined);
  assert.throws(() => auditEvent({ item:{ type:'command_execution' } }), /forbidden/);
  assert.doesNotThrow(() => auditEvent({ item:{ type:'error', message:'Under-development feature warning' } }));
});
test('a bounded child is killed on deadline and unexpected tool events', async () => {
  const timeout = await runProcess(process.execPath, ['-e','setInterval(()=>{},1000)'], { timeout:100 });
  assert.match(timeout.failure.message, /deadline/);
  const event = await runProcess(process.execPath, ['-e','console.log(JSON.stringify({type:"item.started",item:{type:"command_execution"}}));setInterval(()=>{},1000)'], { timeout:2000, audit:true });
  assert.match(event.failure.message, /forbidden/);
});
