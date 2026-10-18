// Two expected diagnostics on one line.
const pair: { a: number; b: string } = { a: "one", b: 2 }; // error // error
return [pair.a, pair.b];
