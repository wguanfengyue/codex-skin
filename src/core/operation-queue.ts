/** Serialize mutations without letting a rejected operation poison subsequent work. */
export function createOperationQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
}
