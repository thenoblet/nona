import { describe, expect, it } from "vitest";
import { nameForOwnGuest } from "./guestName";

describe("nameForOwnGuest (Ruling CG)", () => {
  const kofi = "11111111-1111-4111-8111-111111111111";
  const ama = "22222222-2222-4222-8222-222222222222";

  it("keeps the name the phone has while it belongs to its own guest, as the guest typed it", () => {
    expect(nameForOwnGuest({ name: "Kofi M.", forGuestId: kofi }, { id: kofi, displayName: "Kofi" })).toEqual({ name: "Kofi M.", forGuestId: kofi });
  });

  it("takes the linked guest's name once a link has taken the phone over", () => {
    expect(nameForOwnGuest({ name: "Kofi", forGuestId: kofi }, { id: ama, displayName: "Ama Owusu" })).toEqual({ name: "Ama Owusu", forGuestId: ama });
  });

  it("takes its own guest's name when it never knew which guest its name was for", () => {
    expect(nameForOwnGuest({ name: "Kofi", forGuestId: null }, { id: ama, displayName: "Ama Owusu" })).toEqual({ name: "Ama Owusu", forGuestId: ama });
    expect(nameForOwnGuest({ name: null, forGuestId: null }, { id: ama, displayName: "Ama Owusu" })).toEqual({ name: "Ama Owusu", forGuestId: ama });
  });

  it("keeps the phone's name for a guest who has none", () => {
    expect(nameForOwnGuest({ name: "Kofi", forGuestId: kofi }, { id: ama, displayName: null })).toEqual({ name: "Kofi", forGuestId: ama });
    expect(nameForOwnGuest({ name: null, forGuestId: null }, { id: ama, displayName: null })).toEqual({ name: null, forGuestId: ama });
  });
});
