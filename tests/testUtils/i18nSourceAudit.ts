import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

type TranslationUse = {
  file: string;
  line: number;
  namespace?: string;
  keys: string[];
};
export type TranslationAudit = {
  uses: TranslationUse[];
  unresolved: string[];
  calls: number;
};

/** Enumerate real enum/union values, including imported types, before constructing keys. */
export function auditTranslationSources(root: string): TranslationAudit {
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (file) =>
    readFileSync(file, "utf8"),
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(
    parsed.fileNames.filter((file) =>
      relative(root, file).replaceAll("\\", "/").startsWith("src/"),
    ),
    parsed.options,
  );
  const checker = program.getTypeChecker();
  const typeNames = new Map<ts.Type, string>();
  const typeName = (node: ts.Node): string => {
    const type = checker.getTypeAtLocation(node);
    let name = typeNames.get(type);
    if (name === undefined) {
      name = checker.typeToString(type);
      typeNames.set(type, name);
    }
    return name;
  };
  const audit: TranslationAudit = { uses: [], unresolved: [], calls: 0 };
  for (const source of program.getSourceFiles()) {
    const file = relative(root, source.fileName).replaceAll("\\", "/");
    if (!file.startsWith("src/") || source.isDeclarationFile) continue;
    const add = (
      node: ts.Node,
      expression: ts.Expression,
      namespace?: string,
    ) => {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const keys = expressionValues(expression, checker);
      if (keys) audit.uses.push({ file, line, namespace, keys });
      else
        audit.unresolved.push(`${file}:${line}: ${expression.getText(source)}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        if (
          /^(t|rendererT|tMain|tMainCommon|appI18n\.t|i18n\.t|translate)$/.test(
            name,
          ) ||
          (ts.isIdentifier(node.expression) &&
            mayBeTranslationFunction(
              checker.getTypeAtLocation(node.expression),
            ) &&
            typeName(node.expression).startsWith("TFunction<"))
        ) {
          const argument = node.arguments[name === "translate" ? 1 : 0];
          if (argument) {
            audit.calls++;
            add(node, argument, callNamespace(node, typeName));
          }
        }
      }
      // Option registries intentionally expose broad string fields; check their source values too.
      if (
        ts.isPropertyAssignment(node) &&
        /^(label|description|title|message|tooltip|help|error|empty|hint)Key$/.test(
          node.name.getText(source),
        )
      ) {
        add(node, node.initializer);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "i18nKey") {
        const value = node.initializer;
        if (value && ts.isJsxExpression(value) && value.expression)
          add(node, value.expression, "components");
        else if (value && ts.isStringLiteral(value))
          add(node, value, "components");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return audit;
}

function mayBeTranslationFunction(type: ts.Type): boolean {
  return (
    type.aliasSymbol?.getName() === "TFunction" ||
    type.getSymbol()?.getName() === "TFunction" ||
    (type.isUnionOrIntersection() && type.types.some(mayBeTranslationFunction))
  );
}

function callNamespace(
  node: ts.CallExpression,
  typeName: (node: ts.Node) => string,
): string | undefined {
  const name = node.expression.getText();
  let namespace =
    name === "tMain"
      ? "main"
      : name === "tMainCommon"
        ? "common"
        : name === "rendererT"
          ? "renderer"
          : undefined;
  namespace ??= typeName(node.expression).match(/TFunction<"(\w+)"/)?.[1];
  for (const argument of node.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "ns" &&
        ts.isStringLiteral(property.initializer)
      )
        namespace = property.initializer.text;
    }
  }
  // Unparameterized TFunction uses the library default type, not the bound caller namespace.
  return namespace === "translation" ? undefined : namespace;
}

function expressionValues(
  node: ts.Expression,
  checker: ts.TypeChecker,
): string[] | null {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return expressionValues(node.expression, checker);
  if (ts.isConditionalExpression(node)) {
    const yes = expressionValues(node.whenTrue, checker);
    const no = expressionValues(node.whenFalse, checker);
    return yes && no ? [...new Set([...yes, ...no])] : null;
  }
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const choices = expressionValues(span.expression, checker);
      if (!choices) return null;
      values = values.flatMap((prefix) =>
        choices.map((choice) => prefix + choice + span.literal.text),
      );
    }
    return values;
  }
  return typeValues(checker.getTypeAtLocation(node));
}

function typeValues(type: ts.Type): string[] | null {
  if (type.isStringLiteral()) return [type.value];
  if (type.isUnion()) {
    const values = type.types.map(typeValues);
    return values.every((value) => value !== null)
      ? [...new Set(values.flat())]
      : null;
  }
  return null;
}
