export function isPartialPopulated(partial: Partial<any>, keys: (keyof Partial<any>)[]): boolean {
  for (let key of keys) {
    if (partial[key as string] as any === undefined) return false;
  }
  return true;
}


export function ensurePartialPopulated<T>(partial: Partial<T>, keys: string[]): T {
  if (isPartialPopulated(partial, keys)) return partial as T;
  throw new  Error('partial is unpopulated: ' + JSON.stringify(partial));
}

export type ReadOnlyMap<K,V> = Omit<Map<K,V>, 'set' | 'delete' | 'clear'>


export function isNonNulled<T>(value: T): value is NonNullable<T> {
  return value != null;
}
