// Shell scripts bundled as text (wrangler [[rules]] Text, esbuild --loader:.sh=text).
declare module "*.sh" {
  const text: string;
  export default text;
}
