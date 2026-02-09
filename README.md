Build a simple frontend. The end result should be a website where one can quickly: 

1. sample, 
2. chop up,
3. and arrange,

... disco, funk and soul music in order to more quickly produce hiphop and house beats.

To start with, there should be a /songs/ folder in the root containing mp3s of random old songs (empty for now, I will provide these). When a button is pressed in the frontend, one of these songs is selected at random. An algorithm detects the bpm of the song. Then, another algorithm uses the bpm information to separate the song into beats. Finally, a final algorithm selects 16 random chunks from the song. For every chunk, the user can extend the chunk from 1 beat to 16 beats, with another slider. The chunk this slider refers to changes depending on which chunk is selected. Different chunks should play back by pressing the keys on your computer keyboard. The playback speed, in bpm, should be modifiable with a textfield. Finally, there should be a "download all" button to download the chunks in separate mp3 files, and also a download button for every chunk.