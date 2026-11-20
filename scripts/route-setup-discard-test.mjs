import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRouteSetup } from '../src/route-setup.mjs';

for (const mode of ['advanced', 'action-error', 'referenced']) {
  test('setup keeps its own outcome when intake disposal is '+mode, async t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-setup-discard-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const home=path.join(dir,'route-home'), providerId='fixture-provider';
    const bytes=Buffer.from('synthetic-only-input');
    const operationError=Object.freeze(Object.assign(new Error('synthetic action refusal'),{code:'fixture_action_error'}));
    const handle='synthetic-intake-handle';
    const output=[], events=[];
    let review;
    const gozar={
      async readSetupOperation(ref) {
        const scope={providerId,scopeId:'scope',configurationRevision:7,registryId:'registry'};
        const action={id:'intake',kind:'provide-secret',inputId:'fixture-input',digest:'digest',
          label:'Synthetic intake',disclosure:{revision:1,links:[]},step:{permission:{label:'synthetic step'}},
          consent:{facts:[],consentFactsDigest:'facts',scope:{...scope,operation:{id:ref.operationId,revision:4}}}};
        review={scope,operationId:ref.operationId,revision:4,state:'pending',resources:[],
          evidence:{known:true,value:{summary:'fixture'}},nextAction:action};
        return review;
      },
      async storeSecret(input) {
        events.push('store');assert.equal(input.bytes,bytes);
        assert.equal(input.bytes.toString(),'synthetic-only-input');
        return {handle};
      },
      async runSetupAction(command) {
        events.push('step');assert.equal(command.expectedSetupRevision,4);
        assert.equal(command.secretHandle,handle);
        assert.ok(bytes.every(value=>value===0),'intake bytes are zeroed before action');
        if(mode==='action-error')throw operationError;
        return {...review,revision:5,state:'complete',nextAction:null};
      },
      async discardSecret(input) {
        events.push('discard');assert.deepEqual(input,{home,handle});
        throw Object.assign(new Error('private backend diagnostic must not appear'),
          {code:mode==='referenced'?'secret_in_use':'secret_backend_unavailable'});
      },
    };
    const result=runRouteSetup({gozar,candidate:{providerId,setup:{state:'needs_setup'}},home,
      env:{XDG_CONFIG_HOME:dir},say:line=>output.push(line),ask:async()=> 'yes',askSecret:async()=>bytes});
    if(mode==='action-error')await assert.rejects(result,error=>error===operationError);
    else assert.equal(await result,true);
    assert.deepEqual(events,['store','step','discard']);
    assert.ok(bytes.every(value=>value===0));
    assert.equal(output.some(line=>/cleanup is unconfirmed/.test(line)),mode!=='referenced');
    assert.equal(output.some(line=>/private backend diagnostic|synthetic-intake-handle|synthetic-only-input/.test(line)),false);
  });
}
