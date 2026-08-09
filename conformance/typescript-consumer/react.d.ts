declare module 'react' {
  export interface ReactElement<P = unknown, T = unknown> {
    type: T;
    props: P;
    key: string | null;
  }

  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly ReactNode[];
}

declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: unknown, key?: string): import('react').ReactElement;
  export function jsxs(type: unknown, props: unknown, key?: string): import('react').ReactElement;
  export const Fragment: unique symbol;
}

declare global {
  namespace JSX {
    type Element = import('react').ReactElement;

    interface IntrinsicElements {
      [elementName: string]: unknown;
    }
  }
}

export {};
