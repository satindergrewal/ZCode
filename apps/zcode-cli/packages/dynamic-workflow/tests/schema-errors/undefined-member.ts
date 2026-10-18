// undefined in a non-optional position -- reject (optionality belongs on ?, not | undefined).
interface R {
  value: string | undefined;
}

const g = agent("g");
const v = await g.ask<R>("go"); // error
log(JSON.stringify(v));
