import {
  BehaviorSubject,
  EMPTY,
  from,
  Observable,
  ObservableInput,
  of,
  Subject,
  Subscriber,
  Subscription,
  TeardownLogic,
  OperatorFunction,
  Subscribable,
  Observer,
  Unsubscribable
} from 'rxjs';
import {
  share,
  first,
  concatMap,
  startWith,
  tap,
  mergeAll,
  scan,
  toArray,
  combineLatestAll,
  map,
  distinctUntilChanged,
  filter,
  catchError
} from 'rxjs/operators';
import { isNonNulled, isTruthy, ReadOnlyMap } from './typeUtils';


type Resolve<T> = (value: (T | PromiseLike<T>)) => void;
type Reject = (reason?: any) => void;


export class AlreadyFulfilledError extends Error {
  constructor() {
    super('This promise has already been fi');
  }
}

/**
 * A Promise that can be resolved or rejected externally
 */
export class Future<T> implements Promise<T> {
  public resolve: Resolve<T>;
  public reject: Reject;
  public fulfilled: boolean = false;
  private promise: Promise<T>;
  public then: Promise<T>['then'];
  public catch: Promise<T>['catch'];
  public finally: Promise<T>['finally'];


  constructor() {
    let _resolve: Resolve<T>;
    let _reject: Reject;

    this.promise = new Promise(
      (resolve, reject) => {
        _resolve = resolve;
        _reject = reject;
      });


    this.resolve = (value) => {
      if (this.fulfilled) throw new AlreadyFulfilledError();
      _resolve(value);
    };
    this.reject = (value: any) => {
      if (this.fulfilled) throw new AlreadyFulfilledError();
      _reject(value);
    };

    this.then = ((...args: any[]) => this.promise.then(...args)) as typeof this.promise.then;
    this.catch = ((...args: any[]) => this.promise.catch(...args)) as typeof this.promise.catch;
    this.finally = ((...args: any[]) => this.promise.finally(...args)) as typeof this.promise.finally;
  }

  get [Symbol.toStringTag]() {
    return 'FUTURREEEEEE WOOOO SPOOOOOKYYYY';
  }

}


// export type DeferredSubject<T> = Promise<Subject<T>>;
export type DeferredBehaviorSubject<T> = Promise<BehaviorSubject<T>>;
export type FutureBehaviorSubject<T> = Future<BehaviorSubject<T>>;


export type Change<T> = {
  elt: T;
  type: 'added' | 'removed' | 'updated';
}

export type TimedChange<T> = Change<T> & { time: Date };

export function flattenDeferred<T, O extends Observable<T>>(promise: Promise<O>): O {
  return from(promise).pipe(mergeAll()) as unknown as O;
}


/**
 * mutates set with accumulated change elements
 * @param set
 */
export function accumulateSet<T>(set: Set<T>) {
  return (change: Change<T>) => {
    switch (change.type) {
      case 'added':
        set.add(change.elt);
        break;
      case 'removed':
        set.delete(change.elt);
        break;
    }
  };
}

/**
 * mutates map with accumulated change elements
 * @param map
 * @param getKey
 */
export function accumulateMap<T, K>(map: Map<K, T>, getKey: (elt: T) => K) {
  return (change: Change<T>) => {
    const key = getKey(change.elt);
    switch (change.type) {
      case 'added':
      case 'updated':
        map.set(key, change.elt);
        break;
      case 'removed':
        map.delete(key);
        break;
    }
  };
}

/**
 * derive a many -> one change stream mapping where the resulting observable tracks elements which are currently present across all source observables
 */
export function trackUnifiedState<T>(predicates: boolean[]) {
  return (o: Observable<Observable<ChangeLike<T>>>) =>
    o.pipe(
      map(scanChangesToSet()),
      combineLatestAll(),
      map((sets) => {
        if (predicates.length !== sets.length) throw new Error('predicates not same length as input higher order observable');
        const allElts = sets.map(s => [...s]).flat();
        let matchedAll = new Set<T>();
        allElts.forEach((elt, idx) => {
          const matchesAllPredicates = !sets.some(m => m.has(elt) !== predicates[idx]);
          if (matchesAllPredicates) matchedAll.add(elt);
        });
        return matchedAll;
      }),
      trackSet()
    );
}

export function scanToMap<K, T>(getKey: (elt: T) => K) {
  return (o: Observable<T>): Observable<Map<K, T>> => {
    const eltMap = new Map<K, T>();
    return o.pipe(
      map((elt) => {
        eltMap.set(getKey(elt), elt);
        return eltMap;
      }, new Map<K, T>()),
      startWith(eltMap)
    );
  };
}

export function scanChangesToMap<K, T>(getKey: (elt: T) => K) {
  return (o: Observable<ChangeLike<T>>): Observable<Map<K, T>> => {
    const eltMap = new Map<K, T>();
    return o.pipe(
      map((change) => {
        let changed = false;
        switch (change.type) {
          case 'added':
          case 'updated':
            eltMap.set(getKey(change.elt), change.elt);
            changed = true;
            break;
          case 'removed':
            eltMap.delete(getKey(change.elt));
            changed = true;
            break;
        }
        return (changed) ? eltMap : null;
      }, new Map<K, T>()),
      filter(isNonNulled),
      startWith(eltMap)
    );
  };
}

export function scanChangesToSet<T>() {
  return (o: Observable<ChangeLike<T>>): Observable<Set<T>> => {
    const eltSet = new Set<T>();
    return o.pipe(
      map((change) => {
        let changed = false;
        switch (change.type) {
          case 'added':
            eltSet.add(change.elt);
            changed = true;
            break;
          case 'removed':
            eltSet.delete(change.elt);
            changed = true;
            break;
        }
        return changed ? eltSet : null;
      }),
      filter(isNonNulled),
      startWith(eltSet),
      share()
    );
  };
}

export function trackSet<T>() {
  let prevSet: Set<T> = new Set();
  return (o: Observable<Set<T>>): Observable<Change<T>> =>
    o.pipe(concatMap((currSet) => {
      const changes: Change<T>[] = [];
      for (let key of currSet) {
        if (!prevSet.has(key)) {
          changes.push({
            type: 'added',
            elt: key
          });
        }
      }
      for (let key of prevSet) {
        if (!currSet.has(key)) {
          changes.push({
            type: 'removed',
            elt: key
          });
        }
      }
      return from(changes);
    }));
}

export type ChangeLike<T> = Change<T> | TimedChange<T>;

export function mapChange<T, O>(mapper: (elt: T) => O) {
  return (o: Observable<ChangeLike<T>>): Observable<ChangeLike<O>> =>
    o.pipe(map(change => ({ ...change, elt: mapper(change.elt) })));
}

export function getElt<T>(change: ChangeLike<T>): T {
  return change.elt;
}

export function noOP() {
}

export function changeOfType<T>(changeType: Change<T>['type']) {
  return (o: Observable<Change<T>>): Observable<T> =>
    o.pipe(
      map(change => changeType === change.type ? change.elt : null),
      filter(isNonNulled)
    );

}

export function toChange<T>(type: Change<T>['type']) {
  return (elt: T): Change<T> => ({
    type,
    elt
  });
}

export function countEntities<T>(getKey: (elt: T) => string) {
  return (o: Observable<Change<T>>): Observable<number> => {
    return o.pipe(
      auditChanges(getKey),
      scan((count, change) => {
        if (change.type === 'added') return count + 1;
        if (change.type === 'removed') return count - 1;
        return count;
      }, 0),
      distinctUntilChanged()
    );
  };
}


export class ChangeError<T> extends Error {
  constructor(msg: string, change: ChangeLike<T>) {
    super(msg);
  }
}

export function auditChanges<T, C extends ChangeLike<T>>(getKey: (elt: T) => string) {
  return (o: Observable<C>): Observable<C> => {
    const keys = new Set<string>();
    return o.pipe(
      map((change) => {
        const key = getKey(change.elt);
        switch (change.type) {
          case 'added':
            if (keys.has(key)) throw new ChangeError(`Added Duplicate element with key ${key}`, change);
            keys.add(key);
            break;
          case 'removed':
            if (!keys.has(key)) throw new ChangeError(`Removed non existent element with key ${key}`, change);
            keys.delete(key);
            break;
        }
        return change;
      })
    );
  };
}


export function ignoreRedundantChange<T, K, C extends ChangeLike<T>>(getKey: (elt: T) => K) {
  return (o: Observable<C>): Observable<C> => {
    const keys = new Set<K>();
    return o.pipe(
      map((change): C | null => {
        const key = getKey(change.elt);
        const keySeen = keys.has(key);
        switch (change.type) {
          case 'added': {
            if (keySeen) return null;
            keys.add(key);
            return change;
          }
          case 'removed': {
            if (!keySeen) return null;
            keys.delete(key);
            return change;
          }
          case 'updated': {
            return change;
          }
        }
      }),
      filter(isNonNulled)
    );
  };
}

export type AddResource<T> = {
  type: 'added';
  elt: T;
}

export type UpdateResource<K, E, R> = {
  type: 'updated';
  edit: (elt: R) => E;
  key: K;
};

export type RemoveResource<K> = {
  type: 'removed';
  key: K;
};


export type ResourceChange<T, K, E, R> =
  AddResource<T>
  | UpdateResource<K, E, R>
  | RemoveResource<K>


/**
 * A subject that relies on its consumers to keep track of 'next' callsites, so it can complete
 */
// export class DependentSubject<T> extends Subject<T> {
//   constructor() {
//     super();
//   }
//
//   private refCount = 0;
//
//   addRef(refDisposedOf: Promise<unknown>) {
//     this.refCount += 1;
//     refDisposedOf.then(() => {
//       this.refCount -= 1;
//       if (this.refCount <= 0) this.complete();
//     });
//   }
//
// }

/**
 * A subject that explicitely tracks its dependant observables, and completes when none are left.
 * Will only work when dependent observables are using a non-sync scheduler
 */
export class DependentSubject<T> {
  private _subject = new Subject<T>();
  private observeCount = 0;

  public addDependency(o: Observable<T>) {
    this.observeCount++;

    const sub = o.subscribe({
      next: (elt) => this.subject.next(elt),
      error: (err) => this.subject.error(err),
      complete: () => {
        this.observeCount--;
        if (this.observeCount === 0) this.subject.complete();
      }
    });


    this.subject.subscribe({
      complete: () => sub.unsubscribe()
    });
  }

  public get observable() {
    return this.subject as Observable<T>;
  }

  protected get subject() {
    return this._subject;
  }
}

export class DependentBehaviorSubject<T> extends DependentSubject<any> {
  private bSubject: BehaviorSubject<T>;

  constructor(startingValue: T) {
    super();
    this.bSubject = new BehaviorSubject(startingValue);
  }

  public get value() {
    return this.bSubject.value;
  }

  protected get subject(): Subject<T> {
    return this.bSubject;
  }
}


export interface BehaviorObservable<T> extends Observable<T> {
  value: T;
}

export async function getFirstAfterDeferred<T>(deferredSubject: Promise<BehaviorObservable<T>>): Promise<T> {
  return (await deferredSubject).value;
}


export function catchErrorsOfClass<T>(errorType: Error['constructor']) {
  return (observable: Observable<T>): Observable<T> => observable.pipe(catchError((err, innerObservable) => {
    if (err instanceof errorType) return innerObservable;
    throw err;
  }));
}

// export class BehaviorObservable<T> extends Observable<T> {
//   private bSubject: BehaviorSubject<T>;
//   constructor(subscribe?: (this: Observable<T>, subscriber: Subscriber<T>) => TeardownLogic, initialValue: T) {
//     super(subscribe);
//     this.bSubject = new BehaviorSubject(initialValue);
//     this.subscribe(this.bSubject);
//     this.subscribe({complete: () => this.bSubject.unsubscribe()})
//   }
//
//   public get value() {
//     return this.bSubject;
//   }
// }
