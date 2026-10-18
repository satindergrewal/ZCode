// Class instances are not plain data (methods and prototypes fail the JSON boundary) -- like ask<T>, rejected.
class Finding {
  constructor(readonly path: string) {}
  describe(): string {
    return this.path;
  }
}

report(new Finding("src/a.ts")); // error
