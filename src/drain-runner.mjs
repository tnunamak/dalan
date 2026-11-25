export function createDrainRunner(drain,log) {
  const report=error=>{
    try {
      const result=log({kind:'delivery_drain_error',reason:String(error?.message??error).slice(0,300)});
      // Logging must not create a second, unhandled failure.
      Promise.resolve(result).catch(()=>{});
    } catch {}
  };
  return function runDrain() {
    try { return Promise.resolve(drain()).catch(error=>{ report(error); }); }
    catch(error) { report(error); return Promise.resolve(); }
  };
}
