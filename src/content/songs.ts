export type Song = {
  id: string;
  title: string;
  artist: string;
  /** Length in seconds, shown before the file has loaded. */
  seconds: number;
  /** mp3 plays everywhere (including older iPhones); webm is smaller. */
  sources: { src: string; type: string }[];
};

export const songs: Song[] = [
  {
    id: "just-the-two-of-us",
    title: "Just the Two of Us",
    artist: "Bill Withers & Grover Washington, Jr.",
    seconds: 235,
    sources: [
      { src: "/audio/just-the-two-of-us.webm", type: 'audio/webm; codecs="opus"' },
      { src: "/audio/just-the-two-of-us.mp3", type: "audio/mpeg" },
    ],
  },
  {
    id: "im-so-in-love-with-you",
    title: "I'm So in Love with You",
    artist: "Jeannine Zoe feat. Frank Edwards",
    seconds: 251,
    sources: [
      { src: "/audio/im-so-in-love-with-you.webm", type: 'audio/webm; codecs="opus"' },
      { src: "/audio/im-so-in-love-with-you.mp3", type: "audio/mpeg" },
    ],
  },
  {
    id: "i-wanna-love-you",
    title: "I Wanna Love You",
    artist: "Sarkodie feat. Harmonize",
    seconds: 174,
    sources: [
      { src: "/audio/i-wanna-love-you.webm", type: 'audio/webm; codecs="opus"' },
      { src: "/audio/i-wanna-love-you.mp3", type: "audio/mpeg" },
    ],
  },
];
