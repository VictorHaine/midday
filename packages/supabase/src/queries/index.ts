import { UTCDate } from "@date-fns/utc";
import {
  addDays,
  endOfMonth,
  isWithinInterval,
  startOfMonth,
  subYears,
} from "date-fns";
import type { Client } from "../types";
import { EMPTY_FOLDER_PLACEHOLDER_FILE_NAME } from "../utils/storage";

export function getPercentageIncrease(a: number, b: number) {
  return a > 0 && b > 0 ? Math.abs(((a - b) / b) * 100).toFixed() : 0;
}

export async function getUserQuery(supabase: Client, userId: string) {
  return supabase
    .from("users")
    .select(
      `
      *,
      team:team_id(*)
    `
    )
    .eq("id", userId)
    .single()
    .throwOnError();
}

export async function getCurrentUserTeamQuery(supabase: Client) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return getUserQuery(supabase, user?.id);
}

export async function getBankConnectionsByTeamIdQuery(
  supabase: Client,
  teamId: string
) {
  return supabase
    .from("decrypted_bank_connections")
    .select("*, name:decrypted_name")
    .eq("team_id", teamId)
    .throwOnError();
}

export type GetTeamBankAccountsParams = {
  teamId: string;
  enabled?: boolean;
};

export async function getTeamBankAccountsQuery(
  supabase: Client,
  params: GetTeamBankAccountsParams
) {
  const { teamId, enabled } = params;

  const query = supabase
    .from("decrypted_bank_accounts")
    .select(
      "*, name:decrypted_name, bank:decrypted_bank_connections(*, name:decrypted_name)"
    )
    .eq("team_id", teamId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: false })
    .throwOnError();

  if (enabled) {
    query.eq("enabled", enabled);
  }

  return query;
}

export async function getTeamMembersQuery(supabase: Client, teamId: string) {
  const { data } = await supabase
    .from("users_on_team")
    .select(
      `
      id,
      role,
      team_id,
      user:users(id, full_name, avatar_url, email)
    `
    )
    .eq("team_id", teamId)
    .order("created_at")
    .throwOnError();

  return {
    data,
  };
}

type GetTeamUserParams = {
  teamId: string;
  userId: string;
};

export async function getTeamUserQuery(
  supabase: Client,
  params: GetTeamUserParams
) {
  const { data } = await supabase
    .from("users_on_team")
    .select(
      `
      id,
      role,
      team_id,
      user:users(id, full_name, avatar_url, email)
    `
    )
    .eq("team_id", params.teamId)
    .eq("user_id", params.userId)
    .throwOnError()
    .single();

  return {
    data,
  };
}

export type GetSpendingParams = {
  from: string;
  to: string;
  teamId: string;
  currency: string;
};

export async function getSpendingQuery(
  supabase: Client,
  params: GetSpendingParams
) {
  return supabase.rpc("get_spending", {
    team_id: params.teamId,
    date_from: params.from,
    date_to: params.to,
    currency_target: params.currency,
  });
}

export type GetTransactionsParams = {
  teamId: string;
  to: number;
  from: number;
  sort?: {
    column: string;
    value: "asc" | "desc";
  };
  searchQuery?: string;
  filter?: {
    status?: "fullfilled" | "unfullfilled" | "excluded";
    attachments?: "include" | "exclude";
    categories?: string[];
    type?: "income" | "expense";
    date: {
      from?: string;
      to?: string;
    };
  };
};

export async function getTransactionsQuery(
  supabase: Client,
  params: GetTransactionsParams
) {
  const { from = 0, to, filter, sort, teamId, searchQuery } = params;
  const { date = {}, status, attachments, categories, type } = filter || {};

  const columns = [
    "id",
    "date",
    "amount",
    "currency",
    "category",
    "method",
    "status",
    "note",
    "name:decrypted_name",
    "description:decrypted_description",
    "assigned:assigned_id(*)",
    "bank_account:decrypted_bank_accounts(id, name:decrypted_name, currency, bank_connection:decrypted_bank_connections(id, logo_url))",
    "attachments:transaction_attachments(id, name, size, path, type)",
  ];

  const query = supabase
    .from("decrypted_transactions")
    .select(columns.join(","), { count: "exact" })
    .eq("team_id", teamId);

  if (sort) {
    const [column, value] = sort;
    const ascending = value === "asc";

    if (column === "attachment") {
      query.order("is_fulfilled", { ascending });
    } else if (column === "assigned") {
      query.order("assigned_id", { ascending });
    } else if (column === "bank_account") {
      query.order("bank_account_id", { ascending });
    } else {
      query.order(column, { ascending });
    }
  } else {
    query
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });
  }

  if (date?.from && date?.to) {
    query.gte("date", date.from);
    query.lte("date", date.to);
  }

  if (searchQuery) {
    if (!Number.isNaN(Number.parseInt(searchQuery))) {
      query.like("amount_text", `%${searchQuery}%`);
    } else {
      query.ilike("decrypted_name", `%${searchQuery}%`);
    }
  }

  if (status?.includes("fullfilled") || attachments === "include") {
    query.eq("is_fulfilled", true);
  }

  if (status?.includes("unfulfilled") || attachments === "exclude") {
    query.eq("is_fulfilled", false);
  }

  if (status?.includes("excluded")) {
    query.eq("status", "excluded");
  } else {
    query.or("status.eq.pending,status.eq.posted,status.eq.completed");
  }

  if (categories) {
    const matchCategory = categories
      .map((category) => {
        if (category === "uncategorized") {
          return "category.is.null";
        }
        return `category.eq.${category}`;
      })
      .join(",");

    query.or(matchCategory);
  }

  if (type === "expense") {
    query.lt("amount", 0);
    query.neq("category", "transfer");
  }

  if (type === "income") {
    query.eq("category", "income");
  }

  const { data, count } = await query.range(from, to);

  const totalAmount = data
    ?.filter((transaction) => transaction.category !== "transfer")
    ?.reduce((acc, { amount, currency }) => {
      const existingCurrency = acc.find((item) => item.currency === currency);

      if (existingCurrency) {
        existingCurrency.amount += amount;
      } else {
        acc.push({ amount, currency });
      }
      return acc;
    }, [])
    .sort((a, b) => a?.amount - b?.amount);

  return {
    meta: {
      totalAmount,
      count,
    },
    data: data?.map((transaction) => ({
      ...transaction,
      category: transaction?.category || "uncategorized",
    })),
  };
}

export async function getTransactionQuery(supabase: Client, id: string) {
  const { data } = await supabase
    .from("decrypted_transactions")
    .select(
      `
      *,
      name:decrypted_name,
      description:decrypted_description,
      assigned:assigned_id(*),
      attachments:transaction_attachments(*),
      bank_account:decrypted_bank_accounts(id, name:decrypted_name, currency, bank_connection:decrypted_bank_connections(id, logo_url))
    `
    )
    .eq("id", id)
    .single()
    .throwOnError();

  return {
    ...data,
    category: data?.category || "uncategorized",
  };
}

type GetSimilarTransactionsParams = {
  name: string;
  teamId: string;
};

export async function getSimilarTransactions(
  supabase: Client,
  params: GetSimilarTransactionsParams
) {
  const { name, teamId } = params;

  return supabase
    .from("decrypted_transactions")
    .select("id, amount, team_id", { count: "exact" })
    .eq("decrypted_name", name)
    .eq("team_id", teamId)
    .throwOnError();
}

type GetBankAccountsCurrenciesParams = {
  teamId: string;
};

export async function getBankAccountsCurrenciesQuery(
  supabase: Client,
  params: GetBankAccountsCurrenciesParams
) {
  return supabase.rpc("get_bank_account_currencies", {
    team_id: params.teamId,
  });
}

export type GetBurnRateQueryParams = {
  teamId: string;
  from: string;
  to: string;
  currency: string;
};

export async function getBurnRateQuery(
  supabase: Client,
  params: GetBurnRateQueryParams
) {
  const { teamId, from, to, currency } = params;

  const fromDate = new UTCDate(from);
  const toDate = new UTCDate(to);

  return supabase.rpc("get_burn_rate", {
    team_id: teamId,
    date_from: startOfMonth(fromDate).toDateString(),
    date_to: endOfMonth(toDate).toDateString(),
    currency,
  });
}

export type GetRunwayQueryParams = {
  teamId: string;
  from: string;
  to: string;
  currency: string;
};

export async function getRunwayQuery(
  supabase: Client,
  params: GetRunwayQueryParams
) {
  const { teamId, from, to, currency } = params;

  const fromDate = new UTCDate(from);
  const toDate = new UTCDate(to);

  return supabase.rpc("get_runway", {
    team_id: teamId,
    date_from: startOfMonth(fromDate).toDateString(),
    date_to: endOfMonth(toDate).toDateString(),
    currency,
  });
}

export type GetCurrentBurnRateQueryParams = {
  teamId: string;

  currency: string;
};

export async function getCurrentBurnRateQuery(
  supabase: Client,
  params: GetCurrentBurnRateQueryParams
) {
  const { teamId, currency } = params;

  return supabase.rpc("get_current_burn_rate", {
    team_id: teamId,
    currency,
  });
}

export type GetMetricsParams = {
  teamId: string;
  from: string;
  to: string;
  currency: string;
  type?: "revenue" | "profit";
};

export async function getMetricsQuery(
  supabase: Client,
  params: GetMetricsParams
) {
  const { teamId, from, to, type = "profit", currency } = params;

  const rpc = type === "profit" ? "get_profit" : "get_revenue";

  const fromDate = new UTCDate(from);
  const toDate = new UTCDate(to);

  const [{ data: prevData }, { data: currentData }] = await Promise.all([
    supabase.rpc(rpc, {
      team_id: teamId,
      date_from: subYears(startOfMonth(fromDate), 1).toDateString(),
      date_to: subYears(endOfMonth(toDate), 1).toDateString(),
      currency,
    }),
    supabase.rpc(rpc, {
      team_id: teamId,
      date_from: startOfMonth(fromDate).toDateString(),
      date_to: endOfMonth(toDate).toDateString(),
      currency,
    }),
  ]);

  const prevTotal = prevData?.reduce((value, item) => item.value + value, 0);
  const currentTotal = currentData?.reduce(
    (value, item) => item.value + value,
    0
  );

  return {
    summary: {
      currentTotal,
      prevTotal,
      currency,
    },
    meta: {
      type,
    },
    result: currentData?.map((record, index) => {
      const prev = prevData?.at(index);

      return {
        date: record.date,
        precentage: {
          value: getPercentageIncrease(
            Math.abs(prev?.value),
            Math.abs(record.value)
          ),
          status: record.value > prev?.value ? "positive" : "negative",
        },
        current: {
          date: record.date,
          value: record.value,
          currency,
        },
        previous: {
          date: prev?.date,
          value: prev?.value,
          currency,
        },
      };
    }),
  };
}

export type GetVaultParams = {
  teamId: string;
  path?: string;
};

export async function getVaultQuery(supabase: Client, params: GetVaultParams) {
  const { teamId, path } = params;

  const defaultFolders = path
    ? []
    : [
        { name: "exports", isFolder: true },
        { name: "inbox", isFolder: true },
        { name: "imports", isFolder: true },
        { name: "transactions", isFolder: true },
      ];

  let basePath = teamId;

  if (path) {
    basePath = `${basePath}/${path}`;
  }

  const { data } = await supabase.storage.from("vault").list(basePath, {
    sortBy: { column: "name", order: "asc" },
  });

  const filteredData =
    data
      ?.filter((file) => file.name !== EMPTY_FOLDER_PLACEHOLDER_FILE_NAME)
      .map((item) => ({ ...item, isFolder: !item.id })) ?? [];

  const mergedMap = new Map(
    [...defaultFolders, ...filteredData].map((obj) => [obj.name, obj])
  );

  const mergedArray = Array.from(mergedMap.values());

  return {
    data: mergedArray,
  };
}

export async function getVaultActivityQuery(supabase: Client, userId: string) {
  return supabase
    .from("objects")
    .select("*")
    .eq("owner_id", userId)
    .limit(20)
    .order("created_at", { ascending: false });
}

type GetVaultRecursiveParams = {
  teamId: string;
  path?: string;
  folder?: string;
  limit?: number;
  offset?: number;
};

export async function getVaultRecursiveQuery(
  supabase: Client,
  params: GetVaultRecursiveParams
) {
  const { teamId, path, folder, limit = 10000, offset = 0 } = params;

  let basePath = teamId;

  if (path) {
    basePath = `${basePath}/${path}`;
  }

  if (folder) {
    basePath = `${basePath}/${folder}`;
  }

  const items = [];
  let folderContents: any = [];

  for (;;) {
    const { data } = await supabase.storage.from("vault").list(basePath);

    folderContents = folderContents.concat(data);
    // offset += limit;
    if ((data || []).length < limit) {
      break;
    }
  }

  const subfolders = folderContents?.filter((item) => item.id === null) ?? [];
  const folderItems = folderContents?.filter((item) => item.id !== null) ?? [];

  folderItems.forEach((item) => items.push({ ...item, basePath }));

  const subFolderContents = await Promise.all(
    subfolders.map((folder: any) =>
      getVaultRecursiveQuery(supabase, {
        ...params,
        folder: decodeURIComponent(folder.name),
      })
    )
  );

  subFolderContents.map((subfolderContent) => {
    subfolderContent.map((item) => items.push(item));
  });

  return items;
}

export async function getTeamsByUserIdQuery(supabase: Client, userId: string) {
  return supabase
    .from("users_on_team")
    .select(
      `
      id,
      role,
      team:team_id(*)`
    )
    .eq("user_id", userId)
    .throwOnError();
}

export async function getTeamInvitesQuery(supabase: Client, teamId: string) {
  return supabase
    .from("user_invites")
    .select("id, email, code, role, user:invited_by(*), team:team_id(*)")
    .eq("team_id", teamId)
    .throwOnError();
}

export async function getUserInvitesQuery(supabase: Client, email: string) {
  return supabase
    .from("user_invites")
    .select("id, email, code, role, user:invited_by(*), team:team_id(*)")
    .eq("email", email)
    .throwOnError();
}

type GetUserInviteQueryParams = {
  code: string;
  email: string;
};

export async function getUserInviteQuery(
  supabase: Client,
  params: GetUserInviteQueryParams
) {
  return supabase
    .from("user_invites")
    .select("*")
    .eq("code", params.code)
    .eq("email", params.email)
    .single();
}

type GetInboxQueryParams = {
  teamId: string;
  from?: number;
  to?: number;
  done?: boolean;
  todo?: boolean;
  ascending?: boolean;
  searchQuery?: string;
};

export async function getInboxQuery(
  supabase: Client,
  params: GetInboxQueryParams
) {
  const {
    from = 0,
    to = 10,
    teamId,
    done,
    todo,
    searchQuery,
    ascending = false,
  } = params;

  const columns = [
    "id",
    "file_name",
    "file_path",
    "display_name",
    "transaction_id",
    "amount",
    "currency",
    "content_type",
    "due_date",
    "status",
    "forwarded_to",
    "created_at",
    "website",
    "due_date",
    "transaction:decrypted_transactions(id, amount, currency, name:decrypted_name, date)",
  ];

  const query = supabase
    .from("inbox")
    .select(columns.join(","))
    .eq("team_id", teamId)
    .order("created_at", { ascending });

  if (done) {
    query.not("transaction_id", "is", null);
  }

  if (todo) {
    query.is("transaction_id", null);
  }

  if (searchQuery) {
    if (!Number.isNaN(Number.parseInt(searchQuery))) {
      query.like("inbox_amount_text", `%${searchQuery}%`);
    } else {
      query.textSearch("fts", `${searchQuery}:*`);
    }
  }

  const { data } = await query.range(from, to);
  // TODO: Fix neq in query
  const filteredData = data?.filter((item) => item.status !== "deleted");

  return {
    data: filteredData?.map((item) => {
      const pending = isWithinInterval(new Date(), {
        start: new Date(item.created_at),
        end: addDays(new Date(item.created_at), 45),
      });

      return {
        ...item,
        pending,
        review: !pending && !item.transaction_id,
      };
    }),
  };
}

export type GetTrackerProjectsQueryParams = {
  teamId: string;
  to: number;
  from?: number;
  sort?: {
    column: string;
    value: "asc" | "desc";
  };
  search?: {
    query?: string;
    fuzzy?: boolean;
  };
  filter?: {
    status?: "in_progress" | "completed";
  };
};

export async function getTrackerProjectsQuery(
  supabase: Client,
  params: GetTrackerProjectsQueryParams
) {
  const { from = 0, to = 10, filter, sort, teamId, search } = params;
  const { status } = filter || {};

  const query = supabase
    .from("tracker_projects")
    .select("*, total_duration", { count: "exact" })
    .eq("team_id", teamId);

  if (status) {
    query.eq("status", status);
  }

  if (search?.query && search?.fuzzy) {
    query.ilike("name", `%${search.query}%`);
  }

  if (sort) {
    const [column, value] = sort;
    if (column === "time") {
      query.order("total_duration", { ascending: value === "asc" });
    } else {
      query.order(column, { ascending: value === "asc" });
    }
  } else {
    query.order("created_at", { ascending: false });
  }

  const { data, count } = await query.range(from, to);

  return {
    meta: {
      count,
    },
    data,
  };
}

export type GetTrackerRecordsByRangeParams = {
  teamId: string;
  from: string;
  to: string;
  projectId: string;
};

export async function getTrackerRecordsByRangeQuery(
  supabase: Client,
  params: GetTrackerRecordsByRangeParams
) {
  if (!params.teamId) {
    return null;
  }

  const query = supabase
    .from("tracker_entries")
    .select(
      "*, assigned:assigned_id(id, full_name, avatar_url), project:project_id(id, name)"
    )
    .eq("team_id", params.teamId)
    .gte("date", params.from)
    .lte("date", params.to)
    .order("created_at");

  if (params.projectId) {
    query.eq("project_id", params.projectId);
  }

  const { data } = await query;
  const result = data?.reduce((acc, item) => {
    const key = item.date;

    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});

  const totalDuration = data?.reduce(
    (duration, item) => item.duration + duration,
    0
  );

  return {
    meta: {
      totalDuration,
      from: params.from,
      to: params.to,
    },
    data: result,
  };
}
