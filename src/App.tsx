import Stage from "./ui/Stage";

export default function App() {
  return (
    <main>
      <header className="top">
        <h1>
          Reality is <em>yours</em>.
        </h1>
        <p>Point at something, say what to change.</p>
      </header>
      <Stage />
    </main>
  );
}
