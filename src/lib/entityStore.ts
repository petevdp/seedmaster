import { concat, from, Observable } from 'rxjs';
import {
  share,
  mergeAll,
  map
} from 'rxjs/operators';
import { createObserverTarget } from '../cleanup';
import {
  accumulateMap,
  auditChanges,
  Change, flattenDeferred,
  isDeferred,
  toChange
} from './asyncUtils';
import { mapTo } from './rxOperators';

export type GetKey<K, T> = (elt: T) => K;
export type IndexCollection<L extends string, K, T> = Record<L, GetKey<K, T>>
export type EntityStore<L extends string, K, T> = { state: Record<L, Map<K, T>>; change$: Observable<Change<T>> }
export type PossiblyDeferred<T> = T | Promise<T>;

export function createEntityStore<L extends string, K, T>(change$: Observable<Change<T>>, indexes: IndexCollection<L, K, T>): EntityStore<L, K, T> {
  const changeShared$ = change$.pipe(share());
  const store: EntityStore<L, K, T> = {
    change$: changeShared$,
    state: {} as Record<L, Map<K, T>>
  };

  for (let [label, getKey] of Object.entries(indexes)) {
    const map = new Map<K, T>();
    let getKeyTyped = getKey as GetKey<K, T>;
    createObserverTarget(changeShared$.pipe(auditChanges(getKeyTyped)), { context: `entity-${label}` }, { next: accumulateMap(map, getKeyTyped) });
    store.state[label as L] = map;
  }
  return store;
}


export function processAllEntities<T>(store: PossiblyDeferred<EntityStore<string, unknown, T>>): Observable<Change<T>> {
  if (isDeferred(store)) {
    return flattenDeferred(store.then(store => {
      const out = processAllEntities(store);
      return out;
    }));
  }
  // wrap accessing store.state in cold observable so the caller gets up-to-date values on subscription
  // const existing$ = new Observable<T>((s) => {
  //   const existing = [...Object.values(store.state)[0].values()];
  //   for (let elt of existing) {
  //     s.next(elt);
  //   }
  // }).pipe(map(toChange('added')));
  const existing = [...Object.values(store.state)[0].values()] as T[];
  return concat(
    from(existing).pipe(map(toChange('added'))),
    store.change$
  );
}


// export function trackEntity<L extends string,K,T>(store: PossiblyDeferred<EntityStore<L,K,T>>, index: L, key: K): Observable<Change<T>> {
//   return processAllEntities(store).pipe()
// }
