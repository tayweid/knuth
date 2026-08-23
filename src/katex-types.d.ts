// katex's package.json exports "./contrib/auto-render" without a "types"
// condition, so TS cannot resolve it from the package itself.

declare module 'katex/contrib/auto-render' {
  interface Delimiter {
    left: string;
    right: string;
    display: boolean;
  }

  interface AutoRenderOptions {
    delimiters?: Delimiter[];
    throwOnError?: boolean;
    errorCallback?: (message: string, error: Error) => void;
    preProcess?: (math: string) => string;
    [key: string]: unknown;
  }

  export default function renderMathInElement(
    element: HTMLElement,
    options?: AutoRenderOptions,
  ): void;
}
