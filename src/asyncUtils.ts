import {
  BehaviorSubject,
  concatMap,
  EMPTY,
  Observable,
  ObservableInput,
  of, Subject
} from 'rxjs';
import {
  first
} from 'rxjs/operators';


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
export class Future<T> extends Promise<T> {
  public resolve!: Resolve<T>;
  public reject!: Reject;
  public fulfilled: boolean = false;

  private _resolve!: Resolve<T>;
  private _reject!: Reject;

  constructor() {
    // let reject:
    super((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    this.resolve = (value) => {
      if (this.fulfilled) throw new AlreadyFulfilledError();
      this._resolve(value);
    };
    this.reject = (value: any) => {
      if (this.fulfilled) throw new AlreadyFulfilledError();
      this._reject(value);
    };

  }
}

export type DeferredSubject<T> = Promise<Subject<T>>;
export type DeferredBehaviorSubject<T> = Promise<BehaviorSubject<T>>;
export type FutureSubject<T> = Future<Subject<T>>;
export type FutureBehaviorSubject<T> = Future<BehaviorSubject<T>>;

export async function getFirstAfterDeferred<T>(deferredSubject: DeferredSubject<T>): Promise<T> {
  const subject = await deferredSubject;
  const firstValue = await subject.pipe(first()).toPromise();
  return firstValue as T;
}
