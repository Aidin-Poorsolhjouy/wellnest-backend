export type WellNestRole = 'ADMIN' | 'CAREGIVER' | 'SENIOR';

export type AuthenticatedUser = {
  id: string;
  email?: string;
  role: WellNestRole;
};
