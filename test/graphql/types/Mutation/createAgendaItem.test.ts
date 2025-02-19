import type { FastifyBaseLogger } from "fastify";
import type { Client as MinioClient } from "minio";
import { createMockLogger } from "test/utilities/mockLogger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphQLContext } from "~/src/graphql/context";
import { createAgendaItemResolver } from "~/src/graphql/types/Mutation/createAgendaItem";

interface MockDrizzleClient {
	query: {
		usersTable: {
			findFirst: ReturnType<typeof vi.fn>;
		};
		agendaItemsTable: {
			findFirst: ReturnType<typeof vi.fn>;
		};
		agendaFoldersTable: {
			findFirst: ReturnType<typeof vi.fn>;
		};
	};
	insert: ReturnType<typeof vi.fn>;
	values: ReturnType<typeof vi.fn>;
	returning: ReturnType<typeof vi.fn>;
}

// Simplified TestContext that uses the mock client
interface TestContext extends Omit<GraphQLContext, "log" | "drizzleClient"> {
	drizzleClient: MockDrizzleClient & GraphQLContext["drizzleClient"];
	log: FastifyBaseLogger;
}

// Mock the Drizzle client
const drizzleClientMock = {
	query: {
		usersTable: {
			findFirst: vi.fn(),
		},
		agendaItemsTable: {
			findFirst: vi.fn(),
		},
		agendaFoldersTable: {
			findFirst: vi.fn(),
		},
	},
	insert: vi.fn().mockReturnThis(),
	values: vi.fn().mockReturnThis(),
	returning: vi.fn(),
} as TestContext["drizzleClient"];

const mockLogger = createMockLogger();

const authenticatedContext: TestContext = {
	currentClient: {
		isAuthenticated: true,
		user: {
			id: "user_1",
		},
	},
	drizzleClient: drizzleClientMock,
	log: mockLogger,
	envConfig: {
		API_BASE_URL: "http://localhost:3000",
	},
	jwt: {
		sign: vi.fn().mockReturnValue("mock-token"),
	},
	minio: {
		bucketName: "talawa",
		client: {} as MinioClient, // minimal mock that satisfies the type
	},
	pubsub: {
		publish: vi.fn(),
		subscribe: vi.fn(),
	},
};

const unauthenticatedContext: TestContext = {
	...authenticatedContext,
	currentClient: {
		isAuthenticated: false,
	},
};

describe("createAgendaItem", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	// unauthenticated context
	it("should throw an error if the user is not authenticated", async () => {
		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "1",
						name: "name",
						type: "general",
					},
				},
				unauthenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: { code: "unauthenticated" },
			}),
		);
	});
	// invalid arguments
	it("should throw invalid_arguments error when deleting agenda item with invalid UUID format", async () => {
		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "1",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toMatchObject({
			extensions: { code: "invalid_arguments" },
		});
	});

	// current user not found

	it("should throw unauthenticated error when user ID from token is not found in database", async () => {
		drizzleClientMock.query.usersTable.findFirst.mockResolvedValue(undefined);
		drizzleClientMock.query.agendaFoldersTable.findFirst.mockResolvedValue(
			undefined,
		);

		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "123e4567-e89b-12d3-a456-426614174000",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: {
					code: "unauthenticated",
				},
			}),
		);
	});
	// existing agenda folder not found

	it("should throw arguments_associated_resources_not_found error when agenda folder ID does not exist", async () => {
		drizzleClientMock.query.usersTable.findFirst.mockResolvedValue({
			role: "regular",
		});
		drizzleClientMock.query.agendaFoldersTable.findFirst.mockResolvedValue(
			undefined,
		);

		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "123e4567-e89b-12d3-a456-426614174000",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: {
					code: "arguments_associated_resources_not_found",
					issues: [
						{
							argumentPath: ["input", "id"],
						},
					],
				},
			}),
		);
	});
	// isAgendaItemFolder is false
	it("should throw forbidden_action_on_arguments_associated_resources error when isAgendaItemFolder is false  ", async () => {
		drizzleClientMock.query.usersTable.findFirst.mockResolvedValue({
			role: "regular",
		});
		drizzleClientMock.query.agendaFoldersTable.findFirst.mockResolvedValue({
			isAgendaItemFolder: false,
			event: {
				startAt: "2022-01-01T00:00:00Z",
				organization: {
					countryCode: "us",
					membershipsWhereOrganization: [
						{
							role: "regular",
						},
					],
				},
			},
		});

		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "123e4567-e89b-12d3-a456-426614174000",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: {
					code: "forbidden_action_on_arguments_associated_resources",
					issues: [
						{
							argumentPath: ["input", "folderId"],
							message: "This agenda folder cannot be a folder to agenda items.",
						},
					],
				},
			}),
		);
	});
	// currentUser is not admin and current user membership org not defined
	it("should throw an error if user is non admin and currentUserOrganizatioMembership is undefined", async () => {
		drizzleClientMock.query.usersTable.findFirst.mockResolvedValue({
			role: "regular",
		});
		drizzleClientMock.query.agendaFoldersTable.findFirst.mockResolvedValue({
			isAgendaItemFolder: true,
			event: {
				startAt: "2022-01-01T00:00:00Z",
				organization: {
					countryCode: "us",
					membershipsWhereOrganization: [],
				},
			},
		});

		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "123e4567-e89b-12d3-a456-426614174000",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: {
					code: "unauthorized_action_on_arguments_associated_resources",
					issues: [
						{
							argumentPath: ["input", "id"],
						},
					],
				},
			}),
		);
	});
	// current user membership org not admin
	it("should throw an error if user is non admin and currentUserOrganizatioMembership is not admin", async () => {
		drizzleClientMock.query.usersTable.findFirst.mockResolvedValue({
			role: "regular",
		});
		drizzleClientMock.query.agendaFoldersTable.findFirst.mockResolvedValue({
			isAgendaItemFolder: true,
			event: {
				startAt: "2022-01-01T00:00:00Z",
				organization: {
					countryCode: "us",
					membershipsWhereOrganization: [
						{
							role: "regular",
						},
					],
				},
			},
		});

		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "123e4567-e89b-12d3-a456-426614174000",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: {
					code: "unauthorized_action_on_arguments_associated_resources",
					issues: [
						{
							argumentPath: ["input", "id"],
						},
					],
				},
			}),
		);
	});

	// agenda item is undefined after creation
	it("should throw an error if agenda item is undefined after creation", async () => {
		drizzleClientMock.query.usersTable.findFirst.mockResolvedValue({
			role: "administrator",
		});
		drizzleClientMock.query.agendaFoldersTable.findFirst.mockResolvedValue({
			isAgendaItemFolder: true,
			event: {
				startAt: "2022-01-01T00:00:00Z",
				organization: {
					countryCode: "us",
					membershipsWhereOrganization: [
						{
							role: "administrator",
						},
					],
				},
			},
		});
		drizzleClientMock.insert.mockReturnValue({
			insert: vi.fn().mockReturnThis(),
			values: vi.fn().mockReturnThis(),
			returning: vi.fn().mockResolvedValue([]),
		});

		await expect(
			createAgendaItemResolver(
				{},
				{
					input: {
						folderId: "123e4567-e89b-12d3-a456-426614174000",
						name: "name",
						type: "general",
					},
				},
				authenticatedContext,
			),
		).rejects.toThrowError(
			expect.objectContaining({
				message: expect.any(String),
				extensions: {
					code: "unexpected",
				},
			}),
		);
	});
});
