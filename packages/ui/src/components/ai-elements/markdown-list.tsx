"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

type MarkdownListNodeProp = {
  node?: unknown;
};

export type MarkdownUnorderedListProps = ComponentProps<"ul"> & MarkdownListNodeProp;

export function MarkdownUnorderedList({
  className,
  node: _node,
  ...props
}: MarkdownUnorderedListProps) {
  return (
    <ul
      className={cn(
        "my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-foreground-subtlest",
        "[&_ul]:my-1.5 [&_ol]:my-1.5",
        className,
      )}
      data-markdown-list="unordered"
      data-streamdown="unordered-list"
      {...props}
    />
  );
}

export type MarkdownOrderedListProps = ComponentProps<"ol"> & MarkdownListNodeProp;

export function MarkdownOrderedList({
  className,
  node: _node,
  ...props
}: MarkdownOrderedListProps) {
  return (
    <ol
      className={cn(
        // At two/three-digit ordering, list-outside pushes markers outside the parent; the
        // message bubble clips via overflow-hidden, so a fixed pl truncates the numbers.
        "my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-foreground-subtlest",
        "[&_ul]:my-1.5 [&_ol]:my-1.5",
        className,
      )}
      data-markdown-list="ordered"
      data-streamdown="ordered-list"
      {...props}
    />
  );
}

export type MarkdownListItemProps = ComponentProps<"li"> & MarkdownListNodeProp;

export function MarkdownListItem({ className, node: _node, ...props }: MarkdownListItemProps) {
  return (
    <li
      className={cn("pl-1 [&>p]:my-0 [&>p]:inline", className)}
      data-streamdown="list-item"
      {...props}
    />
  );
}
