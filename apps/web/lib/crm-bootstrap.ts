export const CRM_BOOTSTRAP_USERS = [
  {
    email: "ari@rebattery.io",
    displayName: "Ari",
    passwordEnv: "CRM_BOOTSTRAP_PASSWORD_ARI",
  },
  {
    email: "alex@rebattery.io",
    displayName: "Alex",
    passwordEnv: "CRM_BOOTSTRAP_PASSWORD_ALEX",
  },
] as const;

type BootstrapUser = (typeof CRM_BOOTSTRAP_USERS)[number] & {
  password: string;
};

export function readCrmBootstrapUsers(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapUser[] {
  const users = CRM_BOOTSTRAP_USERS.map((user) => {
    const password = env[user.passwordEnv];
    if (!password) {
      throw new Error(
        `${user.passwordEnv} must be injected at runtime and is never persisted by the bootstrap script`,
      );
    }
    if (password.length < 12 || password.length > 1024) {
      throw new Error(
        `${user.passwordEnv} must be between 12 and 1024 characters`,
      );
    }
    return { ...user, password };
  });

  if (new Set(users.map((user) => user.password)).size !== users.length) {
    throw new Error("CRM bootstrap passwords must be distinct for each user");
  }

  return users;
}

export async function hashCrmBootstrapUsers(
  hashPassword: (password: string) => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const users = readCrmBootstrapUsers(env);
  return Promise.all(
    users.map(async (user) => ({
      email: user.email,
      displayName: user.displayName,
      passwordHash: await hashPassword(user.password),
    })),
  );
}
