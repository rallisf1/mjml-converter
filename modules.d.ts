declare module "mjml-parser-xml" {
  export interface MjmlAstNode {
    tagName: string;
    attributes?: Record<string, string | boolean | number | null | undefined>;
    content?: string;
    children?: MjmlAstNode[];
  }

  export default function mjmlParser(
    input: string,
    options?: Record<string, unknown>,
  ): MjmlAstNode;
}
