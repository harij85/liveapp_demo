import React from 'react';
import './App.css';
import Streaming from './components/Streaming/Streaming';

function App() {
  const primaryUrl = 'https://5ec71ca4ce48.eu-west-1.playback.live-video.net/api/video/v1/eu-west-1.818517946988.channel.WhpZnWv77llP.m3u8';
  const secondaryUrl = 'https://stream.mux.com/8Fqg01HnvSOPDngBmqL6OHaP1EIy00NGoWdpZH9toDM8w.m3u8';
  const tertiaryUrl = 'https://c223d9abb67d57c7.mediapackage.eu-west-1.amazonaws.com/out/v1/238901a4cca640718a23031472ba3d5c/index.m3u8';
  const teamsUrl = 'https://teams.microsoft.com/convene/townhall?eventId=70df42e1-3a7d-45f1-b0ce-457dc368fd75@6e8992ec-76d5-4ea5-8eae-b0c5e558749a&sessionId=9c145800-bf3a-4cbb-b605-51b3dd175f29';

  return (
    <div className="App">
      <header className="App-header">
        <h1>EMEA EXEC Live Stream Test</h1>
        <span className="header-logo">dentsu</span>
      </header>
      <main className="App-main">
        <div className="player-container">
          <Streaming
            primaryUrl={primaryUrl}
            secondaryUrl={secondaryUrl}
            tertiaryUrl={tertiaryUrl}
            teamsUrl={teamsUrl}
            showDebug={true}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
