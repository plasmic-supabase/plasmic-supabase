// useMutationWithOptimisticUpdates.ts

import { useState } from "react";
import { v4 as uuid } from "uuid";
import { buildSupabaseProviderError } from "../helpers/buildSupabaseProviderErr";
import { getMutationPhrases } from "../helpers/getOperationPhrases";
import { useSupabaseMutations } from "./useSupabaseMutations";
import { useOptimisticOperations } from "./useOptimisticOperations";
import { validateFlexibleMutationSettings } from "../helpers/validateFlexibleMutationSettings";
import { validateDynamicOptimisticSettings } from "../helpers/validateDynamicOptimisticSettings";

import type { KeyedMutator } from "swr";

import type {
  EmptyString,
  Row,
  Rows,
  SupabaseProviderMutateResult,
  SupabaseProviderError,
  SupabaseProviderFetchResult,
  RpcResponse,
  MutationTypes,
  FlexibleMutationOperations,
  OptimisticOperation,
  OptimisticRow,
  ReturnCountOptions,
} from "../types";

import {
  type OrderBy,
  Filter,
} from "../helpers/buildSupabaseQueryWithDynamicFilters";

type UseMutationWithOptimisticUpdatesParams = {
  tableName: string;
  columns: string;
  addDelayForTesting: boolean;
  simulateRandomMutationErrors: boolean;
  returnCount?: ReturnCountOptions;
  memoizedOrderBy: OrderBy[];
  uniqueIdentifierField: string;
  memoizedOnMutateSuccess: (mutateResult: SupabaseProviderMutateResult) => void;
  memoizedOnError: (supabaseProviderError: SupabaseProviderError) => void;
};

export const useMutationWithOptimisticUpdates = ({
  tableName,
  columns,
  addDelayForTesting,
  simulateRandomMutationErrors,
  returnCount,
  uniqueIdentifierField,
  memoizedOrderBy,
  memoizedOnMutateSuccess,
  memoizedOnError,
}: UseMutationWithOptimisticUpdatesParams) => {
  // Custom state to track if the component is currently mutating data
  const [isMutating, setIsMutating] = useState<boolean>(false);

  // Build the mutator functions based on dependencies from our custom useSupabaseMutations hook
  const {
    addRowMutator,
    editRowMutator,
    deleteRowMutator,
    flexibleMutator,
    runRpc,
  } = useSupabaseMutations({
    tableName,
    columns,
    uniqueIdentifierField,
    addDelayForTesting,
    simulateRandomMutationErrors,
  });

  // Get the buildOptimisticFunc function from our custom useOptimisticOperations hook
  // This function can be run to return the correct optimistic function to run during mutation
  const {
    addRowOptimistically,
    returnUnchangedData,
    editRowOptimistically,
    deleteRowOptimistically,
    chooseOptimisticFunction,
  } = useOptimisticOperations({
    returnCount,
    uniqueIdentifierField,
    memoizedOrderBy,
  });

  // Function that can handle all types of mutations (addRow, editRow, deleteRow, runRpc, flexibleMutation)
  // It can be run with various settings:
  // - optional optimistic updates
  // - optional immediate return while mutation is in progress
  // - optional return of the row that was mutated
  // - optional error handling callback
  // - optional success callback
  // mutate is the mutator function from useMutablePlasmicQueryData, linked to the SWR cache
  const handleMutation = async ({
    mutationType,
    dataForSupabase,
    shouldReturnRow,
    returnImmediately,
    optimisticRow,
    optimisticData,
    optimisticCount,
    customMetadata,
    mutate,
    flexibleMutationSettings,
    rpcSettings
  }: {
    mutationType: MutationTypes;
    dataForSupabase: Row | Rows | undefined;
    shouldReturnRow: boolean;
    returnImmediately: boolean;
    optimisticRow?: Row;
    optimisticData?: Row | Rows;
    optimisticCount?: number;
    customMetadata?: Object;
    mutate: KeyedMutator<SupabaseProviderFetchResult>;
    flexibleMutationSettings?: {
      tableName: string;
      operation: FlexibleMutationOperations;
      filters?: Filter[];
      optimisticOperation?: OptimisticOperation | EmptyString;
    };
    rpcSettings?: {
      rpcName: string;
      optimisticOperation?: OptimisticOperation | EmptyString;
    }
  }): Promise<SupabaseProviderFetchResult | RpcResponse> => {
    return new Promise((resolve) => {
      setIsMutating(true);

      // for flexibleMutation and rpc, the optimsticOperation can be provided
      // in Plasmic studio if you set then unset optimisticOperation prop in the action
      // it will come through as empty string instead of undefined
      // so we set it to undefined if it's an empty string here
      if (flexibleMutationSettings?.optimisticOperation === "") {
        flexibleMutationSettings.optimisticOperation = undefined;
      }
      if (rpcSettings?.optimisticOperation === "") {
        rpcSettings.optimisticOperation = undefined;
      }

      // If we are running a flexibleMutation, validate the settings
      if (mutationType === "flexibleMutation") {
        validateFlexibleMutationSettings({
          tableName: flexibleMutationSettings?.tableName,
          operation: flexibleMutationSettings?.operation,
          dataForSupabase,
          filters: flexibleMutationSettings?.filters,
        });
        validateDynamicOptimisticSettings({
          optimisticData,
          requestedOptimisticOperation: flexibleMutationSettings?.optimisticOperation,
        });
      }

      if (mutationType === 'rpc') {
        if (!rpcSettings?.rpcName) {
          throw new Error("Error: You must provide an rpcName in runRpc action (error in in handleMutationWithOptimisticUpdate)");
        }
        validateDynamicOptimisticSettings({
          optimisticData,
          requestedOptimisticOperation: rpcSettings.optimisticOperation
        });
      }

      // Get the phrases for referring to this operation
      // Eg "insert" is from the element action "Add Row", the in progress message is "Add row in progress", etc
      const mutationPhrases = getMutationPhrases(mutationType);

      // Check if we have an optimisticRow or optimisticData
      // Only one is valid at a time
      if (optimisticRow && optimisticData) {
        throw new Error(
          "Error in handleMutationWithOptimisticUpdates: You can only specify an optimisticRow or optimisticData, not both"
        );
      }

      //If we have an optimisticRow, add the optimisticId and isOptimistic properties
      let optimisticRowFinal: OptimisticRow | undefined;
      if (optimisticRow) {
        optimisticRowFinal = {
          ...optimisticRow,
          optimisticId: uuid(),
          isOptimistic: true,
        };
      }

      // If we have optimisticData and it's an non-array object, assume its an individual Row
      // and therefore add the optimisticId and isOptimistic properties
      // Otherwise assume optimisticData is Rows or undefined. Set it to optimisticDataFinal unchanged
      let optimisticDataFinal: Rows | undefined = undefined;
      if (
        optimisticData &&
        !Array.isArray(optimisticData) &&
        typeof optimisticData === "object"
      ) {
        optimisticRowFinal = {
          ...optimisticData,
          optimisticId: uuid(),
          isOptimistic: true,
        } as OptimisticRow;
      } else {
        optimisticDataFinal = optimisticData;
      }

      // Resolve immediately if returnImmediately is true
      // The mutation will still run in the background (see below)
      if (returnImmediately) {
        const result: SupabaseProviderMutateResult = {
          data: null,
          count: null,
          optimisticData: optimisticRowFinal || optimisticDataFinal || null,
          optimisticCount: optimisticCount || null,
          dataForSupabase,
          action: mutationType,
          summary: mutationPhrases.inProgress,
          status: "pending",
          error: null,
          customMetadata,
        };
        resolve(result);
      }

      // Helper to create a flexibleMutator function that has same inputs as normal mutators
      // Used when building mutator functions below
      const createFlexibleMutator = ({
        dataForSupabase,
        shouldReturnRow,
      }: {
        dataForSupabase: Row | Rows | undefined;
        shouldReturnRow: boolean;
      }) => {
        // We already know that the flexibleMutationSettings are valid from the validation above
        // So we can safely use them here with the ! operator
        return flexibleMutator({
          tableName: flexibleMutationSettings!.tableName,
          flexibleMutationOperation: flexibleMutationSettings!.operation,
          dataForSupabase,
          filters: flexibleMutationSettings!.filters,
          runSelectAfterMutate: shouldReturnRow,
        });
      };

      // Helper to create rpcMutator function that has same inputs as normal mutators
      // Used when building mutator functions below
      const createRpcMutator = ({
        dataForSupabase,
      }: {
        dataForSupabase: any;
      }) => {
        return runRpc({
          // Due to previous checks, we know that rpcSettings is defined if we are running the rpc mutation
          rpcName: rpcSettings!.rpcName,
          dataForSupabase,
        });
      };

      // Select the appropriate mutator & optimistic functions
      // based on mutationType & presence/absense of optimistic data
      let mutatorFunction;
      let optimisticFunc;
      switch (mutationType) {
        case "insert":
          mutatorFunction = addRowMutator;
          optimisticFunc = optimisticRowFinal
            ? addRowOptimistically
            : returnUnchangedData;
          break;
        case "update":
          mutatorFunction = editRowMutator;
          optimisticFunc = optimisticRowFinal
            ? editRowOptimistically
            : returnUnchangedData;
          break;
        case "delete":
          mutatorFunction = deleteRowMutator;
          optimisticFunc = optimisticRowFinal
            ? deleteRowOptimistically
            : returnUnchangedData;
          break;
        case "flexibleMutation":
          mutatorFunction = createFlexibleMutator;

          optimisticFunc = chooseOptimisticFunction({
            requestedOptimisticOperation:
              flexibleMutationSettings?.optimisticOperation,
            optimisticRowFinal,
            optimisticDataFinal,
            optimisticCount,
          });

          break;
        case "rpc":
          mutatorFunction = createRpcMutator;

          optimisticFunc = chooseOptimisticFunction({
            requestedOptimisticOperation: rpcSettings?.optimisticOperation,
            optimisticRowFinal,
            optimisticDataFinal,
            optimisticCount,
          });

          break;

        default:
          throw new Error(
            "Error in handleMutationWithOptimisticUpdates: Invalid operation"
          );
      }

      // Run the mutation
      mutate(mutatorFunction({ dataForSupabase, shouldReturnRow }), {
        optimisticData: (currentData) =>
          optimisticFunc(
            currentData,
            //Pass in the optimisticRowFinal if it exists, otherwise pass in the optimisticData, otherwise undefined
            //This fits all the possible optimistic functions
            //Logic previously in the component ensures that only the correct optimistic data exists
            //And that the presence or absense of optimistic data has lead to the correct optimistic function being selected
            //Including lack of any optimistic data leading to the returnUnchangedData function
            (optimisticRowFinal as OptimisticRow) || undefined
          ),
        populateCache: false,
        revalidate: true,
        rollbackOnError: true,
      })
        .then((response) => {
          let result: SupabaseProviderMutateResult = {
            data: response ? response.data : null,
            count: response ? response.count : null,
            optimisticData: optimisticRowFinal || optimisticDataFinal || null,
            optimisticCount: optimisticCount || null,
            dataForSupabase,
            action: mutationType,
            summary: mutationPhrases.success,
            status: "success",
            error: null,
            customMetadata,
          };

          if (memoizedOnMutateSuccess) {
            memoizedOnMutateSuccess(result);
          }

          if (!returnImmediately) {
            resolve(result);
          }
        })
        .catch((err) => {
          const supabaseProviderError = buildSupabaseProviderError({
            error: err,
            actionAttempted: mutationType,
            summary: mutationPhrases.error,
            dataForSupabase,
            optimisticData: optimisticRowFinal || optimisticDataFinal || null,
            customMetadata,
          });

          if (memoizedOnError) {
            memoizedOnError(supabaseProviderError);
          }

          if (!returnImmediately) {
            const result: SupabaseProviderMutateResult = {
              data: null,
              count: null,
              optimisticData: optimisticRowFinal || optimisticDataFinal || null,
              optimisticCount: optimisticCount || null,
              dataForSupabase,
              action: mutationType,
              summary: mutationPhrases.error,
              status: "error",
              error: supabaseProviderError,
              customMetadata,
            };
            resolve(result);
          }
        });
    });
  };

  return {
    handleMutation,
    isMutating,
    setIsMutating,
  };
};
