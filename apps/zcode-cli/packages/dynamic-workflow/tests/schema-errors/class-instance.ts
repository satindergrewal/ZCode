// Class instances carry behavior, not plain data -- reject.
class Widget {
  constructor(public id: string) {}
  render(): string {
    return this.id;
  }
}

interface Holder {
  widget: Widget;
}

const g = agent("g");
const v = await g.ask<Holder>("go"); // error
log(JSON.stringify(v));
