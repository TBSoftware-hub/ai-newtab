import { transform } from "sucrase";
import { parse } from "@babel/parser";

export function validateHomepageCode(code: string): void {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const imports = ast.program.body.filter((node) => node.type === "ImportDeclaration");
  if (!imports.some((node) => node.specifiers.some((s) =>
    s.type === "ImportDefaultSpecifier" && s.local.name === "React") && node.source.value === "react" && node.importKind !== "type")) {
    throw new Error("Homepage must import React from 'react'.");
  }
  if (imports.some((node) => node.source.value !== "react")) {
    throw new Error("React is the only permitted homepage import.");
  }
  const exported = ast.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  const declaration = exported?.declaration;
  const namedFunction = declaration?.type === "FunctionDeclaration" && declaration.id?.name === "PersonalizedHomepage";
  const namedBinding = declaration?.type === "Identifier" && declaration.name === "PersonalizedHomepage" &&
    ast.program.body.some((node) =>
      (node.type === "FunctionDeclaration" && node.id?.name === "PersonalizedHomepage") ||
      (node.type === "VariableDeclaration" && node.declarations.some((d) =>
        d.id.type === "Identifier" && d.id.name === "PersonalizedHomepage" &&
        (d.init?.type === "ArrowFunctionExpression" || d.init?.type === "FunctionExpression"))));
  if (!namedFunction && !namedBinding) throw new Error("Homepage must default-export the functional component PersonalizedHomepage.");
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const node = value as Record<string, unknown>;
    const callee = node.callee && typeof node.callee === "object"
      ? node.callee as Record<string, unknown> : undefined;
    if (node.type === "ImportExpression" || node.type === "TSImportEqualsDeclaration" ||
      (node.type === "CallExpression" && (callee?.type === "Import" || callee?.name === "require")) ||
      ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source)) {
      throw new Error("Dynamic imports, require, and re-exports are not permitted.");
    }
    Object.values(node).forEach(inspect);
  };
  inspect(ast.program);
  transform(code, { transforms: ["typescript", "imports", "jsx"] });
}

/**
 * Turn the agent's TSX into JS that Sandpack's React template can run. If the
 * transform throws, fall back to the raw source — Sandpack compiles TSX too.
 */
export function toRenderable(tsx: string): string {
  try {
    return transform(tsx, { transforms: ["typescript", "imports", "jsx"] }).code.replace(`"use strict";`, "");
  } catch (err) {
    console.warn("[transpile] sucrase failed, using raw source", err);
    return tsx;
  }
}
