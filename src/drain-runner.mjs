export function createDrainRunner(drain,log) {
  const report=error=>{
    try { log({kind:'delivery_drain_error',reason:String(error?.message??error).slice(0,300)}); } catch {}
  };
  return function runDrain() {
    try { return Promise.resolve(drain()).catch(error=>{ report(error); }); }
    catch(error) { report(error); return Promise.resolve(); }
  };
}
