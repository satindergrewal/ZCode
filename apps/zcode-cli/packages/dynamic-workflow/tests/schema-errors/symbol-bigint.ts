// symbol and bigint are not JSON-serializable -- reject.
interface WithSymbol {
  tag: symbol;
}
interface WithBigInt {
  huge: bigint;
}

const g = agent("g");
const a = await g.ask<WithSymbol>("sym"); // error
const b = await g.ask<WithBigInt>("big"); // error
log(JSON.stringify(a) + JSON.stringify(b));
