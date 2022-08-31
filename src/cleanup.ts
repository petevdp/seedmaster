import {
  BehaviorSubject,
  Observable,
  Observer,
  PartialObserver,
  Subject,
  Subscription,
  Unsubscribable
} from 'rxjs';
import { mapTo, takeUntil, filter, tap, catchError } from 'rxjs/operators';
import { Future } from './lib/asyncUtils';
import { setTimeout } from 'timers/promises';

import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';
import { logger } from './globalServices/logger';

const flush$ = new Future<void>();
const masterSubject = new Subject<any>();

const masterSub: Subscription = new Subscription();

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
  const abortTime = setTimeout(minutesToMilliseconds(15));


  return subRefCount
    .pipe(
      filter(refCount => refCount === 0),
      mapTo(true),
      takeUntil(abortTime.then(() => false)),
      tap((succeeded) => succeeded ? logger.info('successfully flushed streams') : logger.info('flush attempt timed out, aborting'))
    )
    .toPromise() as Promise<boolean>;
}

let subRefCount = new BehaviorSubject<number>(0);

type ObserverNoError<T> = Omit<Partial<Observer<T>>, 'error'>;

/**
 * tracks how many observables passed to it are still open, and provides top level error logging and handling
 * @param observable
 * @param observer
 */
export function addSubToMaster<T>(observable: Observable<T>, observer: ObserverNoError<T>  | null = null) {
  subRefCount.next(subRefCount.value + 1);
  const errorHandledObservable = observable.pipe(
    // catchError((err, o) => {
    //   logger.error(err);
    //   return o;
    // })
  );
  masterSub.add(errorHandledObservable.subscribe({
    complete: () => {
      observer?.complete && observer.complete();
      subRefCount.next(subRefCount.value - 1);
    },
    next: (elt) => observer?.next && observer.next(elt)
  }));
}
