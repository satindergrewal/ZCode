// Recursive types -> $defs/$ref: direct and member-mediated self references.
interface TreeNode {
  value: number;
  children: TreeNode[];
}

interface Category {
  name: string;
  parent?: Category;
  items: string[];
}

const g = agent("g");
const tree = await g.ask<TreeNode>("build a tree");
const category = await g.ask<Category>("build a category");
log(JSON.stringify(tree) + JSON.stringify(category));
