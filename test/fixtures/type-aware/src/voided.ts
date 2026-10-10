declare function fetchThing(): Promise<void>;
export const b = () => {
  void fetchThing();
};
