// Function values are not JSON-serializable -- report rejects them at the call site.
// Also proof of report site-targeting: the diagnostic lands on the report call, nowhere else.
const compute = (n: number): number => n * 2;
report(compute); // error
report({ ok: true, count: 2 });
