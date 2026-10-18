// never cannot be expressed as any value -- reject (the top-level type argument is never).
const g = agent("g");
const v = await g.ask<never>("go"); // error
log(String(v));
