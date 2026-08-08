declare module "next/navigation" {
  export interface AppRouterInstance {
    push(href: string, options?: { scroll?: boolean }): void;
    replace(href: string, options?: { scroll?: boolean }): void;
    prefetch(href: string): void;
    back(): void;
    forward(): void;
    refresh(): void;
  }

  export function useRouter(): AppRouterInstance;
  export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T;
  export function usePathname(): string;
  
  export interface ReadonlyURLSearchParams {
    get(name: string): string | null;
    getAll(name: string): string[];
    has(name: string): boolean;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    entries(): IterableIterator<[string, string]>;
    forEach(callbackfn: (value: string, key: string, parent: ReadonlyURLSearchParams) => void, thisArg?: any): void;
    toString(): string;
  }

  export function useSearchParams(): ReadonlyURLSearchParams;
  
  export const RedirectType: {
    push: "push";
    replace: "replace";
  };

  export function redirect(url: string, type?: "push" | "replace"): never;
  export function permanentRedirect(url: string, type?: "push" | "replace"): never;
  export function notFound(): never;
  export function forbidden(): never;
  export function unauthorized(): never;
}
