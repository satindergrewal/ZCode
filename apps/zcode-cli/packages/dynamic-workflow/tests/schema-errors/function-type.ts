// Function types are not serializable -- reject (top-level functions and object methods alike).
interface WithMethod {
  transform: (input: string) => number;
}

const g = agent("g");
const v = await g.ask<WithMethod>("go"); // error
log(JSON.stringify(v));
