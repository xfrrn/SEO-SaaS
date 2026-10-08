import { createAccessControl } from "../../access";

export const defaultStatements = {
	audit: ["list"],
	user: [
		"create",
		"list",
		"set-role",
		"ban",
		"impersonate",
		"impersonate-admins",
		"delete",
		"set-password",
		"set-email",
		"get",
		"update",
	],
	session: ["list", "revoke", "delete"],
} as const;

export const defaultAc = createAccessControl(defaultStatements);

export const adminAc = defaultAc.newRole({
	audit: ["list"],
	user: [
		"create",
		"list",
		"set-role",
		"ban",
		"impersonate",
		"delete",
		"set-password",
		"set-email",
		"get",
		"update",
	],
	session: ["list", "revoke", "delete"],
});

export const userAc = defaultAc.newRole({
	audit: [],
	user: [],
	session: [],
});

export const defaultRoles = {
	admin: adminAc,
	user: userAc,
};
