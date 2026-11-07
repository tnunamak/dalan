import {executeProtocolOwnerCommand} from './protocol-owner-command.mjs';

const flatten=receipt=>({...receipt.value,revision:receipt.revision});
export function answerProtocolQuestion(store,id,questionId,text,ownerToken,ctx) {
  return store.transaction(()=>flatten(executeProtocolOwnerCommand(store,id,ownerToken,
    {...ctx,operation:'answer',args:{questionId,text}},()=>{
      const value=store.answerQuestionInTransaction(id,questionId,text);
      store.protocolEventInTransaction(id,'answered',{question_id:questionId});
      return value;
    })));
}
export function cancelProtocolJob(store,id,reason,ownerToken,ctx) {
  return store.transaction(()=>flatten(executeProtocolOwnerCommand(store,id,ownerToken,
    {...ctx,operation:'cancel',args:{reason}},()=>{
      const row=store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
      if(!row||['finished','cancelled'].includes(row.status))
        throw Object.assign(new Error('TERMINAL: assignment is terminal'),{code:'TERMINAL'});
      const value=store.cancelInTransaction(id,reason);
      store.protocolEventInTransaction(id,'cancelled',{reason});
      return value;
    })));
}
