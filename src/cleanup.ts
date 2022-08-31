import {
  BehaviorSubject,
  Observable,
  Observer,
  PartialObserver,
  Subject,
  Subscription,
  Unsubscribable
} from 'rxjs';
import {
  mapTo,
  takeUntil,
  map,
  filter,
  tap,
  catchError,
  endWith
} from 'rxjs/operators';
import {
  auditChanges,
  Change,
  Future, scanChangesToMap,
  scanChangesToSet
} from './lib/asyncUtils';
import { setTimeout } from 'timers/promises';
import { v4 as uuidv4 } from 'uuid';

import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';
import { logger, ppObj } from './globalServices/logger';
import secondsToMilliseconds from 'date-fns/secondsToMilliseconds';
import { isNonNulled } from './lib/typeUtils';

const flush$ = new Future<void>();
const masterSubject = new Subject<any>();

const masterSub: Subscription = new Subscription();


const observerLabel = new Subject<Change<string>>();
const observerCounts$ = new Subject<Map<string, number>>();
const observerMap = new Map<string, number>();

observerLabel
  .pipe(
    map(change => {
      if (change.type === 'added' && observerMap.has(change.elt)) {
        observerMap.set(change.elt, (observerMap.get(change.elt) as number) + 1);
        return observerMap;
      }
      if (change.type === 'added' && !observerMap.has(change.elt)) {
        observerMap.set(change.elt, 1);
        return observerMap;
      }
      if (change.type === 'removed' && observerMap.has(change.elt)) {
        observerMap.set(change.elt, (observerMap.get(change.elt) as number) - 1);
        return observerMap;
      }
      return null;
    }),
    filter(isNonNulled)
  )
  .subscribe(observerCounts$);


observerLabel.subscribe(change => {
  logger.info(`observer change: ${change.type} ${change.elt}`, change);
});

type ObserverNoError<T> = Omit<Partial<Observer<T>>, 'error'>;

/**
 * tracks how many observables passed to it are still open, and provides top level error logging and handling
 * @param observable
 * @param observer
 */
export function addSubToMaster<T>(observable: Observable<T>, label: string | null /*= null */, observer: ObserverNoError<T> | null = null) {
  let labelWithDefault = label || 'anonymous';
  observerLabel.next({ type: 'added', elt: labelWithDefault });
  const errorHandledObservable = observable.pipe(
    // catchError((err, o) => {
    //   logger.error(err);
    //   return o;
    // })
  );
  masterSub.add(errorHandledObservable.subscribe({
    complete: () => {
      observer?.complete && observer.complete();
      observerLabel.next({ type: 'removed', elt: labelWithDefault });
    },
    next: (elt) => observer?.next && observer.next(elt)
  }));
}


export function getObserverCountRepr(): string {
  const obj: any = {};
  for (let [label, count] of observerMap.entries())
    obj[label] = count;
  return ppObj(obj);
}

export function getObserverCountRepr$(): Observable<string> {
  return observerCounts$.pipe(map(getObserverCountRepr));
}

export function registerInputObservable<T>() {
  return (observable: Observable<T>): Observable<T> => {
    const out = observable.pipe(takeUntil(flush$));
    out.subscribe(masterSubject);
    return out;
  };
}

export function tryToFlushInputObservables(): Promise<boolean> {
  logger.info('attempting to flush streams, winding down...');
  flush$.resolve();
  const abortTime = setTimeout(secondsToMilliseconds(5));


  return observerCounts$
    .pipe(
      filter(map => map.size === 0),
      mapTo(true),
      takeUntil(abortTime),
      endWith(false),
      tap((succeeded) => succeeded ? logger.info('successfully flushed streams') : logger.info('flush attempt timed out, aborting'))
    )
    .toPromise() as Promise<boolean>;
}
