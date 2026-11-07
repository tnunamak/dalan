// Parse only newline-terminated lines. A reader can see an appended line half-written: a write that crosses a
// page boundary makes the first page visible (i_size grows per page) before the rest is copied, and reads do not
// wait for the writer. The unterminated tail is incomplete, not corrupt; the next read sees it whole.
export function completeJsonLines(text) {
  const end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
