import type { TokenType } from "../tokenizer/types.ts";
import type Parser from "../parser/index.ts";
import type * as N from "../types.ts";
import type { Node as NodeType, NodeBase, File } from "../types.ts";
import type { Position } from "../util/location.ts";
import { Errors } from "../parse-error.ts";
import type { Undone } from "../parser/node.ts";
import type { BindingFlag } from "../util/scopeflags.ts";
import { OptionFlags } from "../options.ts";
import type { ExpressionErrors } from "../parser/util.ts";

const { defineProperty } = Object;
const toUnenumerable = (object: any, key: string) => {
  if (object) {
    defineProperty(object, key, { enumerable: false, value: object[key] });
  }
};

function toESTreeLocation(node: any) {
  toUnenumerable(node.loc.start, "index");
  toUnenumerable(node.loc.end, "index");

  return node;
}

export default (superClass: typeof Parser) =>
  class ESTreeParserMixin extends superClass implements Parser {
    parse(): File {
      const file = toESTreeLocation(super.parse());

      if (this.optionFlags & OptionFlags.Tokens) {
        file.tokens = file.tokens.map(toESTreeLocation);
      }

      return file;
    }

    // @ts-expect-error ESTree plugin changes node types
    parseRegExpLiteral({ pattern, flags }): N.EstreeRegExpLiteral {
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(pattern, flags);
      } catch (_) {
        // In environments that don't support these flags value will
        // be null as the regex can't be represented natively.
      }
      const node = this.estreeParseLiteral<N.EstreeRegExpLiteral>(regex);
      node.regex = { pattern, flags };

      return node;
    }

    // @ts-expect-error ESTree plugin changes node types
    parseBigIntLiteral(value: any): N.Node {
      // https://github.com/estree/estree/blob/master/es2020.md#bigintliteral
      let bigInt: bigint | null;
      try {
        bigInt = BigInt(value);
      } catch {
        bigInt = null;
      }
      const node = this.estreeParseLiteral<N.EstreeBigIntLiteral>(bigInt);
      node.bigint = String(node.value || value);

      return node;
    }

    // @ts-expect-error ESTree plugin changes node types
    parseDecimalLiteral(value: any): N.Node {
      // https://github.com/estree/estree/blob/master/experimental/decimal.md
      // todo: use BigDecimal when node supports it.
      const decimal: null = null;
      const node = this.estreeParseLiteral(decimal);
      node.decimal = String(node.value || value);

      return node;
    }

    estreeParseLiteral<T extends N.EstreeLiteral>(value: any) {
      // @ts-expect-error ESTree plugin changes node types
      return this.parseLiteral<T>(value, "Literal");
    }

    // @ts-expect-error ESTree plugin changes node types
    parseStringLiteral(value: any): N.Node {
      return this.estreeParseLiteral(value);
    }

    parseNumericLiteral(value: any): any {
      return this.estreeParseLiteral(value);
    }

    // @ts-expect-error ESTree plugin changes node types
    parseNullLiteral(): N.Node {
      return this.estreeParseLiteral(null);
    }

    parseBooleanLiteral(value: boolean): N.BooleanLiteral {
      // @ts-expect-error ESTree plugin changes node types
      return this.estreeParseLiteral(value);
    }

    // https://github.com/estree/estree/blob/master/es2020.md#chainexpression
    estreeParseChainExpression(
      node: N.Expression,
      endLoc: Position,
    ): N.EstreeChainExpression {
      const chain = this.startNodeAtNode<N.EstreeChainExpression>(node);
      chain.expression = node;
      return this.finishNodeAt(chain, "ChainExpression", endLoc);
    }

    // Cast a Directive to an ExpressionStatement. Mutates the input Directive.
    directiveToStmt(directive: N.Directive): N.ExpressionStatement {
      const expression = directive.value as any as N.EstreeLiteral;
      delete directive.value;

      this.castNodeTo(expression, "Literal");
      expression.raw = expression.extra.raw;
      expression.value = expression.extra.expressionValue;

      const stmt = this.castNodeTo(directive, "ExpressionStatement");
      stmt.expression = expression;
      stmt.directive = expression.extra.rawValue;

      delete expression.extra;

      return stmt;
    }

    /**
     * The TS-ESLint always define optional AST properties, here we provide the
     * default value for such properties immediately after `finishNode` was invoked.
     * This hook will be implemented by the typescript plugin.
     *
     * Note: This hook should be manually invoked when we change the `type` of a given AST
     * node, to ensure that the optional properties are correctly filled.
     * @param node The AST node finished by finishNode
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fillOptionalPropertiesForTSESLint(node: NodeType) {}

    cloneEstreeStringLiteral(node: N.EstreeLiteral): N.EstreeLiteral {
      const { start, end, loc, range, raw, value } = node;
      const cloned = Object.create(node.constructor.prototype);
      cloned.type = "Literal";
      cloned.start = start;
      cloned.end = end;
      cloned.loc = loc;
      cloned.range = range;
      cloned.raw = raw;
      cloned.value = value;
      return cloned;
    }

    // ==================================
    // Overrides
    // ==================================

    initFunction(node: N.BodilessFunctionOrMethodBase, isAsync: boolean): void {
      super.initFunction(node, isAsync);
      node.expression = false;
    }

    checkDeclaration(node: N.Pattern | N.ObjectProperty): void {
      if (node != null && this.isObjectProperty(node)) {
        // @ts-expect-error plugin typings
        this.checkDeclaration((node as unknown as N.EstreeProperty).value);
      } else {
        super.checkDeclaration(node);
      }
    }

    getObjectOrClassMethodParams(method: N.ObjectMethod | N.ClassMethod) {
      return (method as unknown as N.EstreeMethodDefinition).value.params;
    }

    isValidDirective(stmt: N.Statement): stmt is N.ExpressionStatement {
      return (
        stmt.type === "ExpressionStatement" &&
        stmt.expression.type === "Literal" &&
        typeof stmt.expression.value === "string" &&
        !stmt.expression.extra?.parenthesized
      );
    }

    parseBlockBody(
      node: N.BlockStatementLike,
      allowDirectives: boolean | undefined | null,
      topLevel: boolean,
      end: TokenType,
      afterBlockParse?: (hasStrictModeDirective: boolean) => void,
    ): void {
      super.parseBlockBody(
        node,
        allowDirectives,
        topLevel,
        end,
        afterBlockParse,
      );

      const directiveStatements = node.directives.map(d =>
        this.directiveToStmt(d),
      );
      // @ts-expect-error estree plugin typings
      node.body = directiveStatements.concat(node.body);
      delete node.directives;
    }

    parsePrivateName(): any {
      const node = super.parsePrivateName();
      if (!process.env.BABEL_8_BREAKING) {
        if (!this.getPluginOption("estree", "classFeatures")) {
          return node;
        }
      }
      return this.convertPrivateNameToPrivateIdentifier(node);
    }

    convertPrivateNameToPrivateIdentifier(
      node: N.PrivateName,
    ): N.EstreePrivateIdentifier {
      const name = super.getPrivateNameSV(node);
      node = node as any;
      delete node.id;
      // @ts-expect-error mutate AST types
      node.name = name;
      return this.castNodeTo(node, "PrivateIdentifier");
    }

    // @ts-expect-error ESTree plugin changes node types
    isPrivateName(node: N.Node): node is N.EstreePrivateIdentifier {
      if (!process.env.BABEL_8_BREAKING) {
        if (!this.getPluginOption("estree", "classFeatures")) {
          return super.isPrivateName(node);
        }
      }
      return node.type === "PrivateIdentifier";
    }

    // @ts-expect-error ESTree plugin changes node types
    getPrivateNameSV(node: N.EstreePrivateIdentifier): string {
      if (!process.env.BABEL_8_BREAKING) {
        if (!this.getPluginOption("estree", "classFeatures")) {
          return super.getPrivateNameSV(node as unknown as N.PrivateName);
        }
      }
      return node.name;
    }

    // @ts-expect-error plugin may override interfaces
    parseLiteral<T extends N.Literal>(value: any, type: T["type"]): T {
      const node = super.parseLiteral<T>(value, type);
      // @ts-expect-error mutating AST types
      node.raw = node.extra.raw;
      delete node.extra;

      return node;
    }

    parseFunctionBody(
      node: N.Function,
      allowExpression?: boolean | null,
      isMethod: boolean = false,
    ): void {
      super.parseFunctionBody(node, allowExpression, isMethod);
      node.expression = node.body.type !== "BlockStatement";
    }

    // @ts-expect-error plugin may override interfaces
    parseMethod<
      T extends N.ClassPrivateMethod | N.ObjectMethod | N.ClassMethod,
    >(
      node: Undone<T>,
      isGenerator: boolean,
      isAsync: boolean,
      isConstructor: boolean,
      allowDirectSuper: boolean,
      type: T["type"],
      inClassScope: boolean = false,
    ):
      | N.EstreeProperty
      | N.EstreeMethodDefinition
      | N.EstreeTSAbstractMethodDefinition {
      let funcNode = this.startNode<N.MethodLike>();
      funcNode.kind = node.kind; // provide kind, so super method correctly sets state
      funcNode = super.parseMethod(
        funcNode,
        isGenerator,
        isAsync,
        isConstructor,
        allowDirectSuper,
        type,
        inClassScope,
      );
      delete funcNode.kind;
      const { typeParameters } = node;
      if (typeParameters) {
        delete node.typeParameters;
        funcNode.typeParameters = typeParameters;
        this.resetStartLocationFromNode(funcNode, typeParameters);
      }
      const valueNode = this.castNodeTo(
        funcNode as N.MethodLike,
        process.env.BABEL_8_BREAKING &&
          this.hasPlugin("typescript") &&
          !funcNode.body
          ? "TSEmptyBodyFunctionExpression"
          : "FunctionExpression",
      );
      (
        node as unknown as Undone<
          | N.EstreeProperty
          | N.EstreeMethodDefinition
          | N.EstreeTSAbstractMethodDefinition
        >
      ).value = valueNode;
      if (type === "ClassPrivateMethod") {
        node.computed = false;
      }
      if (process.env.BABEL_8_BREAKING && this.hasPlugin("typescript")) {
        // @ts-expect-error todo(flow->ts) property not defined for all types in union
        if (node.abstract) {
          // @ts-expect-error remove abstract from TSAbstractMethodDefinition
          delete node.abstract;
          return this.finishNode(
            // @ts-expect-error cast methods to estree types
            node as Undone<N.EstreeTSAbstractMethodDefinition>,
            "TSAbstractMethodDefinition",
          );
        }
      }
      if (type === "ObjectMethod") {
        if ((node as any as N.ObjectMethod).kind === "method") {
          (node as any as N.EstreeProperty).kind = "init";
        }
        (node as any as N.EstreeProperty).shorthand = false;
        return this.finishNode(
          // @ts-expect-error cast methods to estree types
          node as Undone<N.EstreeProperty>,
          "Property",
        );
      } else {
        return this.finishNode(
          // @ts-expect-error cast methods to estree types
          node as Undone<N.EstreeMethodDefinition>,
          "MethodDefinition",
        );
      }
    }

    nameIsConstructor(key: N.Expression | N.PrivateName): boolean {
      if (key.type === "Literal") return key.value === "constructor";
      return super.nameIsConstructor(key);
    }

    parseClassProperty(...args: [N.ClassProperty]): any {
      const propertyNode = super.parseClassProperty(...args);
      if (!process.env.BABEL_8_BREAKING) {
        if (!this.getPluginOption("estree", "classFeatures")) {
          return propertyNode as unknown as N.EstreePropertyDefinition;
        }
      }
      if (
        process.env.BABEL_8_BREAKING &&
        propertyNode.abstract &&
        this.hasPlugin("typescript")
      ) {
        delete propertyNode.abstract;
        this.castNodeTo(propertyNode, "TSAbstractPropertyDefinition");
      } else {
        this.castNodeTo(propertyNode, "PropertyDefinition");
      }
      return propertyNode;
    }

    parseClassPrivateProperty(...args: [N.ClassPrivateProperty]): any {
      const propertyNode = super.parseClassPrivateProperty(...args);
      if (!process.env.BABEL_8_BREAKING) {
        if (!this.getPluginOption("estree", "classFeatures")) {
          return propertyNode as unknown as N.EstreePropertyDefinition;
        }
      }
      if (
        process.env.BABEL_8_BREAKING &&
        propertyNode.abstract &&
        this.hasPlugin("typescript")
      ) {
        this.castNodeTo(propertyNode, "TSAbstractPropertyDefinition");
      } else {
        this.castNodeTo(propertyNode, "PropertyDefinition");
      }
      propertyNode.computed = false;
      return propertyNode;
    }

    parseClassAccessorProperty(
      this: Parser,
      node: N.ClassAccessorProperty,
    ): any {
      const accessorPropertyNode = super.parseClassAccessorProperty(node);
      if (!process.env.BABEL_8_BREAKING) {
        if (!this.getPluginOption("estree", "classFeatures")) {
          return accessorPropertyNode;
        }
      }
      if (accessorPropertyNode.abstract && this.hasPlugin("typescript")) {
        delete accessorPropertyNode.abstract;
        this.castNodeTo(accessorPropertyNode, "TSAbstractAccessorProperty");
      } else {
        this.castNodeTo(accessorPropertyNode, "AccessorProperty");
      }
      return accessorPropertyNode;
    }

    parseObjectProperty(
      prop: N.ObjectProperty,
      startLoc: Position | undefined | null,
      isPattern: boolean,
      refExpressionErrors?: ExpressionErrors | null,
    ): N.ObjectProperty | undefined | null {
      const node: N.EstreeProperty = super.parseObjectProperty(
        prop,
        startLoc,
        isPattern,
        refExpressionErrors,
      ) as any;

      if (node) {
        node.kind = "init";
        this.castNodeTo(node, "Property");
      }

      return node as any;
    }

    finishObjectProperty(node: Undone<N.ObjectProperty>): N.ObjectProperty {
      (node as unknown as Undone<N.EstreeProperty>).kind = "init";
      return this.finishNode(
        node as unknown as Undone<N.EstreeProperty>,
        "Property",
      ) as any;
    }

    isValidLVal(
      type: string,
      isUnparenthesizedInAssign: boolean,
      binding: BindingFlag,
    ) {
      return type === "Property"
        ? "value"
        : super.isValidLVal(type, isUnparenthesizedInAssign, binding);
    }

    isAssignable(node: N.Node, isBinding?: boolean): boolean {
      if (node != null && this.isObjectProperty(node)) {
        return this.isAssignable(node.value, isBinding);
      }
      return super.isAssignable(node, isBinding);
    }

    toAssignable(node: N.Node, isLHS: boolean = false): void {
      if (node != null && this.isObjectProperty(node)) {
        const { key, value } = node;
        if (this.isPrivateName(key)) {
          this.classScope.usePrivateName(
            this.getPrivateNameSV(key),
            key.loc.start,
          );
        }
        this.toAssignable(value, isLHS);
      } else {
        super.toAssignable(node, isLHS);
      }
    }

    toAssignableObjectExpressionProp(
      prop: N.Node,
      isLast: boolean,
      isLHS: boolean,
    ) {
      if (
        prop.type === "Property" &&
        (prop.kind === "get" || prop.kind === "set")
      ) {
        this.raise(Errors.PatternHasAccessor, prop.key);
      } else if (prop.type === "Property" && prop.method) {
        this.raise(Errors.PatternHasMethod, prop.key);
      } else {
        super.toAssignableObjectExpressionProp(prop, isLast, isLHS);
      }
    }

    finishCallExpression<T extends N.CallExpression | N.OptionalCallExpression>(
      unfinished: Undone<T>,
      optional: boolean,
    ): T {
      const node = super.finishCallExpression(unfinished, optional);

      if (node.callee.type === "Import") {
        this.castNodeTo(node, "ImportExpression");
        (node as N.Node as N.EstreeImportExpression).source = node
          .arguments[0] as N.Expression;
        (node as N.Node as N.EstreeImportExpression).options =
          (node.arguments[1] as N.Expression) ?? null;
        // compatibility with previous ESTree AST
        // TODO(Babel 8): Remove this
        (node as N.Node as N.EstreeImportExpression).attributes =
          (node.arguments[1] as N.Expression) ?? null;
        // arguments isn't optional in the type definition
        delete node.arguments;
        // callee isn't optional in the type definition
        delete node.callee;
      } else if (node.type === "OptionalCallExpression") {
        this.castNodeTo(node, "CallExpression");
      } else {
        node.optional = false;
      }

      return node;
    }

    toReferencedArguments(
      node:
        | N.CallExpression
        | N.OptionalCallExpression
        | N.EstreeImportExpression,
      /* isParenthesizedExpr?: boolean, */
    ) {
      // ImportExpressions do not have an arguments array.
      if (node.type === "ImportExpression") {
        return;
      }

      super.toReferencedArguments(node);
    }

    parseExport(
      unfinished: Undone<N.AnyExport>,
      decorators: N.Decorator[] | null,
    ) {
      const exportStartLoc = this.state.lastTokStartLoc;
      const node = super.parseExport(unfinished, decorators);

      switch (node.type) {
        case "ExportAllDeclaration":
          // @ts-expect-error mutating AST types
          node.exported = null;
          break;

        case "ExportNamedDeclaration":
          if (
            node.specifiers.length === 1 &&
            node.specifiers[0].type === "ExportNamespaceSpecifier"
          ) {
            this.castNodeTo(node, "ExportAllDeclaration");
            // @ts-expect-error mutating AST types
            node.exported = node.specifiers[0].exported;
            delete node.specifiers;
          }

        // fallthrough
        case "ExportDefaultDeclaration":
          {
            const { declaration } = node;
            if (
              declaration?.type === "ClassDeclaration" &&
              declaration.decorators?.length > 0 &&
              // decorator comes before export
              declaration.start === node.start
            ) {
              this.resetStartLocation(
                node,
                // For compatibility with ESLint's keyword-spacing rule, which assumes that an
                // export declaration must start with export.
                // https://github.com/babel/babel/issues/15085
                // Here we reset export declaration's start to be the start of the export token
                exportStartLoc,
              );
            }
          }

          break;
      }

      return node;
    }

    stopParseSubscript(base: N.Expression, state: N.ParseSubscriptState) {
      const node = super.stopParseSubscript(base, state);
      if (state.optionalChainMember) {
        return this.estreeParseChainExpression(node, base.loc.end);
      }
      return node;
    }

    parseMember(
      base: N.Expression,
      startLoc: Position,
      state: N.ParseSubscriptState,
      computed: boolean,
      optional: boolean,
    ) {
      const node = super.parseMember(base, startLoc, state, computed, optional);
      if (node.type === "OptionalMemberExpression") {
        this.castNodeTo(node, "MemberExpression");
      } else {
        node.optional = false;
      }
      return node;
    }

    isOptionalMemberExpression(node: N.Node) {
      if (node.type === "ChainExpression") {
        return node.expression.type === "MemberExpression";
      }
      return super.isOptionalMemberExpression(node);
    }

    hasPropertyAsPrivateName(node: N.Node): boolean {
      if (node.type === "ChainExpression") {
        node = node.expression;
      }
      return super.hasPropertyAsPrivateName(node);
    }

    // @ts-expect-error ESTree plugin changes node types
    isObjectProperty(node: N.Node): node is N.EstreeProperty {
      return node.type === "Property" && node.kind === "init" && !node.method;
    }

    // @ts-expect-error ESTree plugin changes node types
    isObjectMethod(node: N.Node): node is N.EstreeProperty {
      return (
        node.type === "Property" &&
        (node.method || node.kind === "get" || node.kind === "set")
      );
    }

    /* ============================================================ *
     * parser/node.ts                                               *
     * ============================================================ */

    castNodeTo<T extends N.Node["type"]>(
      node: N.Node,
      type: T,
    ): Extract<N.Node, { type: T }> {
      const result = super.castNodeTo(node, type);
      this.fillOptionalPropertiesForTSESLint(result);
      return result;
    }

    cloneIdentifier<T extends N.Identifier | N.Placeholder>(node: T): T {
      const cloned = super.cloneIdentifier(node);
      this.fillOptionalPropertiesForTSESLint(cloned);
      return cloned;
    }

    cloneStringLiteral<
      T extends N.EstreeLiteral | N.StringLiteral | N.Placeholder,
    >(node: T): T {
      if (node.type === "Literal") {
        return this.cloneEstreeStringLiteral(node) as T;
      }
      return super.cloneStringLiteral(node);
    }

    finishNodeAt<T extends NodeType>(
      node: Undone<T>,
      type: T["type"],
      endLoc: Position,
    ): T {
      return toESTreeLocation(super.finishNodeAt(node, type, endLoc));
    }

    // Override for TS-ESLint that does not allow optional AST properties
    finishNode<T extends NodeType>(node: Undone<T>, type: T["type"]): T {
      const result = super.finishNode(node, type);
      this.fillOptionalPropertiesForTSESLint(result);
      return result;
    }

    resetStartLocation(node: N.Node, startLoc: Position) {
      super.resetStartLocation(node, startLoc);
      toESTreeLocation(node);
    }

    resetEndLocation(
      node: NodeBase,
      endLoc: Position = this.state.lastTokEndLoc,
    ): void {
      super.resetEndLocation(node, endLoc);
      toESTreeLocation(node);
    }
  };
