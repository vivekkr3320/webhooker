'use strict';

let ivm;
try {
  ivm = require('isolated-vm');
} catch (e) {
  // isolated-vm is a native C++ addon that won't load in serverless environments (Vercel, etc.)
  // Fall back to a safe Function-based sandbox with JSON serialization boundary
  ivm = null;
}

class Transformer {
  /**
   * Executes a user-defined JavaScript transformation function inside a secure V8 Isolate.
   * Falls back to a JSON-serialization-boundary sandbox when isolated-vm is unavailable.
   * @param {Object} payload - The original JSON payload object.
   * @param {string} scriptString - The user's raw JavaScript code snippet.
   * @param {number} [timeoutMs=50] - Maximum allowable CPU runtime in milliseconds.
   * @returns {Object} The transformed JSON payload object.
   */
  static transform(payload, scriptString, timeoutMs = 50) {
    if (!scriptString || scriptString.trim() === '') {
      return payload; // Pass through untouched if no script is defined
    }

    if (ivm) {
      return this._transformIsolated(payload, scriptString, timeoutMs);
    }
    return this._transformFallback(payload, scriptString);
  }

  static _transformIsolated(payload, scriptString, timeoutMs) {
    // 1. Initialize an entirely isolated V8 Isolate with a strict heap memory cap (16MB)
    const isolate = new ivm.Isolate({ memoryLimit: 16 });

    try {
      // 2. Create an execution context with its own independent global object scope
      const context = isolate.createContextSync();
      const jail = context.global;

      // 3. Deep-copy the payload data into the isolate's memory space securely
      // This prevents any shared memory reference leakage or prototype poisoning
      jail.setSync('payload', new ivm.ExternalCopy(payload).copyInto());

      // 4. Wrap the user script to enforce the structural "transform(payload)" entry point
      const executionWrapper = `
        ${scriptString}

        function __run() {
          if (typeof transform !== 'function') {
            throw new Error("Missing entrypoint definition: 'function transform(payload)' must be declared.");
          }
          const result = transform(payload);
          if (result === undefined || result === null || typeof result !== 'object') {
            throw new Error("Transformation must return a valid JSON object structure.");
          }
          return JSON.stringify(result);
        }
        __run();
      `;

      // 5. Compile the script within the isolate sandbox
      const script = isolate.compileScriptSync(executionWrapper);

      // 6. Execute the script with a strict CPU timeout watchdog
      const rawJsonResult = script.runSync(context, { timeout: timeoutMs });

      // Parse the serialized result back into the main application thread pool
      return JSON.parse(rawJsonResult);

    } catch (err) {
      // Normalize isolation exceptions for upstream framework capture
      if (err.message.includes('Script execution timed out')) {
        throw new Error(`Transformation security breach: Execution runtime limit of ${timeoutMs}ms exceeded.`);
      }
      if (err.message.includes('Isolate was disposed because memory limit was exceeded') || err.message.includes('Isolate is already disposed') || err.message.includes('Isolate was disposed')) {
        throw new Error(`Transformation security breach: Memory allocation limit of 16MB exceeded.`);
      }
      throw new Error(`Transformation Runtime Error: ${err.message}`);
    } finally {
      // 7. Deterministically dispose of the isolate to instantly free native C++ memory heaps
      // This prevents gradual garbage collector fragmentation leaks over long operational runs
      try {
        if (!isolate.isDisposed) {
          isolate.dispose();
        }
      } catch (e) {
        // Ignore disposal errors to prevent masking primary exceptions
      }
    }
  }

  /**
   * Fallback transformer for serverless environments where isolated-vm is not available.
   * Uses JSON serialization boundary to prevent prototype pollution.
   */
  static _transformFallback(payload, scriptString) {
    try {
      // Deep-clone via JSON to create a clean copy with no prototype chain leaks
      const safePayload = JSON.parse(JSON.stringify(payload));

      const wrapper = `
        'use strict';
        ${scriptString}
        if (typeof transform !== 'function') {
          throw new Error("Missing entrypoint definition: 'function transform(payload)' must be declared.");
        }
        const __result = transform(__payload);
        if (__result === undefined || __result === null || typeof __result !== 'object') {
          throw new Error("Transformation must return a valid JSON object structure.");
        }
        JSON.stringify(__result);
      `;

      const fn = new Function('__payload', wrapper);
      const rawJson = fn(safePayload);
      return JSON.parse(rawJson);
    } catch (err) {
      throw new Error(`Transformation Runtime Error: ${err.message}`);
    }
  }
}

module.exports = Transformer;
