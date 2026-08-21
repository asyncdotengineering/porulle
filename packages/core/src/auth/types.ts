export interface Actor {
  type: "user" | "api_key";
  userId: string | null;
  email: string | null;
  name: string;
  vendorId: string | null;
  organizationId: string | null;
  role: string;
  permissions: string[];
}
