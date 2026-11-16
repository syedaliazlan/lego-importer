// Test helper (not a test file): a stand-in for the `admin` object that
// authenticate.admin() returns, shaped like the real library so tests do not
// rely on reply shapes admin.graphql never produces.
//
// What the real admin.graphql does, read in the installed library source:
//   - @shopify/shopify-app-react-router dist/esm/server/clients/admin/graphql.mjs
//     resolves with `new Response(JSON.stringify(apiResponse))`, where
//     apiResponse is { data, extensions, headers }: a resolved reply never
//     carries `errors`.
//   - @shopify/shopify-api dist/esm/lib/clients/common.mjs throwFailedRequest
//     THROWS a GraphqlQueryError for a 200 reply with GraphQL errors: message
//     is the first error's message, body.errors.graphQLErrors the raw array.
//   - For a 5xx (or 429) when retries were asked for, throwFailedRequest
//     throws HttpMaxRetriesError, which is passed on as it is.
//   - Any other HTTP error status becomes an HttpResponseError, which
//     authenticate/admin/helpers/handle-client-error.mjs rethrows as a plain
//     `Response`.

import { GraphqlQueryError, HttpMaxRetriesError } from "@shopify/shopify-api";

/**
 * The error admin.graphql throws for a 200 reply carrying GraphQL errors.
 * @param {Array<{message: string, extensions?: object, path?: Array<string|number>}>} graphQLErrors
 */
export function graphqlQueryError(graphQLErrors) {
  return new GraphqlQueryError({
    message: graphQLErrors[0]?.message ?? "GraphQL operation failed",
    response: new Response(null, { status: 200 }),
    headers: {},
    body: {
      errors: {
        networkStatusCode: 200,
        message: "An error occurred while fetching from the API. Review 'graphQLErrors' for details.",
        graphQLErrors,
      },
    },
  });
}

/** What admin.graphql throws for a 4xx status other than 429. */
export function httpErrorResponse(status) {
  return new Response("{}", { status });
}

/** What admin.graphql throws for a 5xx (or 429) once `tries` is set. */
export function httpMaxRetriesError() {
  return new HttpMaxRetriesError("Attempted the maximum number of retries for HTTP request.");
}

export const THROTTLED = [{ message: "Throttled", extensions: { code: "THROTTLED" } }];

function operationName(query) {
  return /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

/**
 * @param {(name: string, variables: object|undefined, calls: Array<object>) => object|Promise<object>} handler
 *   returns the reply body ({ data }) for the named operation, or throws
 */
export function fakeAdmin(handler) {
  const calls = [];
  return {
    calls,
    graphql: async (query, options = {}) => {
      const call = { name: operationName(query), query, options, variables: options.variables };
      calls.push(call);
      const body = await handler(call.name, call.variables, calls);
      return new Response(JSON.stringify(body));
    },
  };
}
