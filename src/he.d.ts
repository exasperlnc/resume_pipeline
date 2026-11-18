// he 2.x ships ESM with named exports and no type declarations.
declare module "he" {
  export function decode(html: string, options?: { isAttributeValue?: boolean; strict?: boolean }): string;
  export function encode(text: string, options?: { useNamedReferences?: boolean }): string;
}
