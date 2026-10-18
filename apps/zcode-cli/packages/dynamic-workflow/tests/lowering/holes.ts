// Holes lower to `__host.hole(siteId, name, prompt ?? void 0, (__src) => eval(__src), body?)`
// (execution-engine.md, "lowering" rows for hole): the evaluator is emitted AT THE SITE so its
// direct eval runs in the hole's lexical scope; a filled hole passes its lowered body as the
// fifth argument and the same body comes back as text in `holeBodies`. Body sites carry the
// hole's own `hole#<hash>/` prefix; the outer ids are the ones a script without the body has.
interface Survey {
  slowest: string;
}
interface Plan {
  groups: string[][];
}
interface Verdict {
  pass: boolean;
}
const survey = await agent("scout").ask<Survey>("list the slowest test files");
const plan = await hole<Plan>("plan grouping", `Slowest: ${survey.slowest}`, async () => {
  phase("grouping");
  const draft = await agent("grouper").ask<Plan>(`Group by module: ${survey.slowest}`);
  report({ groups: draft.groups.length });
  return draft;
});
const order = await hole<string>("ordering");
const done = await agent("runner").ask<string>(`Run ${plan.groups.length} groups, ${order} first`);
return await hole<Verdict>("verdict", `Run result: ${done}`);
