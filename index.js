require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const { getData } = require('spotify-url-info')(require('node-fetch'));

// --- FFmpeg automatic setup ---
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
process.env.FFMPEG_PATH = ffmpegPath;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- Slash commands ---
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song from YouTube or Spotify')
    .addStringOption(opt => opt.setName('query').setDescription('YouTube URL, Spotify URL, or search term').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the song'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and leave'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode')
    .addStringOption(opt => opt.setName('mode').setDescription('off, song, queue').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Song', value: 'song' }, { name: 'Queue', value: 'queue' })),
  new SlashCommandBuilder().setName('queue').setDescription('Show current queue')
].map(cmd => cmd.toJSON());

// --- Register commands ---
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Commands registered!');
  } catch (err) { console.error(err); }
})();

// --- Queue embed ---
function createQueueEmbed(serverQueue) {
  const current = serverQueue.songs[0];
  const description = serverQueue.songs.slice(1, 11)
    .map((song, i) => `**${i+2}.** ${song.title} | ${song.duration || 'N/A'} | Requested by <@${song.requester}>`)
    .join('\n') || 'No more songs in queue';

  const videoId = current.url.includes('youtube.com') ? current.url.split('v=')[1]?.split('&')[0] : null;
  const thumbnail = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;

  return new EmbedBuilder()
    .setTitle('🎶 Music Queue')
    .setColor('Random')
    .setThumbnail(thumbnail)
    .setDescription(`**Now Playing:**\n${current.title} | ${current.duration || 'N/A'} | Requested by <@${current.requester}>\n\n**Up Next:**\n${description}`);
}

// --- Play song ---
async function playSong(guildId) {
  const serverQueue = queue.get(guildId);
  if (!serverQueue) return;

  if (!serverQueue.songs.length) {
    if (serverQueue.loop === 'queue' && serverQueue.allSongs) serverQueue.songs = [...serverQueue.allSongs];
    else { serverQueue.connection.destroy(); queue.delete(guildId); serverQueue.textChannel.send('Queue ended. Leaving the VC.'); return; }
  }

  const song = serverQueue.songs[0];
  const stream = ytdl(song.url, { filter: 'audioonly', highWaterMark: 1 << 25 });
  const resource = createAudioResource(stream);
  serverQueue.player.play(resource);

  serverQueue.player.once(AudioPlayerStatus.Idle, () => {
    if (serverQueue.loop === 'song') playSong(guildId);
    else { if (serverQueue.loop==='queue') serverQueue.songs.push(serverQueue.songs.shift()); else serverQueue.songs.shift(); playSong(guildId); }
  });

  serverQueue.textChannel.send({ embeds: [createQueueEmbed(serverQueue)] });
}

// --- Interaction handler ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const { commandName, options, member, guild } = interaction;

  let serverQueue = queue.get(guild.id);

  // Check voice channel
  if (commandName === 'play' && !member.voice.channel) return interaction.reply('You must be in a voice channel!');

  if (commandName === 'play') {
    try {
      await interaction.deferReply(); // Defer immediately

      let query = options.getString('query');
      let songInfo;

      // Spotify link
      if (query.includes('spotify.com')) {
        const spotifyData = await getData(query);
        query = spotifyData.name + ' ' + spotifyData.artists.map(a => a.name).join(' ');
      }

      // YouTube search/URL
      if (ytdl.validateURL(query)) {
        const song = await ytdl.getInfo(query);
        songInfo = { title: song.videoDetails.title, url: song.videoDetails.video_url, duration: new Date(song.videoDetails.lengthSeconds*1000).toISOString().substr(11,8), requester: member.id };
      } else {
        const result = await ytSearch(query);
        if (!result.videos.length) return interaction.editReply('No results found!');
        const video = result.videos[0];
        songInfo = { title: video.title, url: video.url, duration: video.timestamp, requester: member.id };
      }

      // Permissions
      const permissions = member.voice.channel.permissionsFor(guild.members.me);
      if (!permissions.has('Connect') || !permissions.has('Speak')) return interaction.editReply('I need Connect & Speak permissions!');

      // New queue
      if (!serverQueue) {
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
        const connection = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
        connection.subscribe(player);

        serverQueue = { textChannel: interaction.channel, connection, player, songs: [songInfo], allSongs: [songInfo], loop: 'off' };
        queue.set(guild.id, serverQueue);
        playSong(guild.id);
        return interaction.editReply({ embeds: [createQueueEmbed(serverQueue)] });
      } else {
        serverQueue.songs.push(songInfo);
        serverQueue.allSongs.push(songInfo);

        if (serverQueue.connection.joinConfig.channelId !== member.voice.channel.id) {
          serverQueue.connection.destroy();
          const connection = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
          connection.subscribe(serverQueue.player);
          serverQueue.connection = connection;
        }

        return interaction.editReply({ embeds: [createQueueEmbed(serverQueue)] });
      }

    } catch (err) {
      console.error(err);
      return interaction.editReply('Error playing this track.');
    }
  }

  if (!serverQueue) return interaction.reply('No music playing!');

  if (commandName === 'skip') { serverQueue.player.stop(); interaction.reply('⏭ Skipped!'); }
  if (commandName === 'pause') { serverQueue.player.pause(); interaction.reply('⏸ Paused!'); }
  if (commandName === 'resume') { serverQueue.player.unpause(); interaction.reply('▶ Resumed!'); }
  if (commandName === 'stop') { serverQueue.songs=[]; serverQueue.player.stop(); serverQueue.connection.destroy(); queue.delete(guild.id); interaction.reply('⏹ Stopped!'); }
  if (commandName === 'loop') { serverQueue.loop = options.getString('mode'); interaction.reply(`🔁 Loop mode: **${serverQueue.loop}**`); }
  if (commandName === 'queue') { interaction.reply({ embeds: [createQueueEmbed(serverQueue)] }); }
});

// --- Auto-move VC ---
client.on('voiceStateUpdate', (oldState, newState) => {
  const serverQueue = queue.get(oldState.guild.id);
  if (!serverQueue) return;
  if (oldState.channelId && newState.channelId && oldState.id !== client.user.id) {
    const botVC = serverQueue.connection.joinConfig.channelId;
    if (botVC !== newState.channelId) {
      const permissions = newState.channel.permissionsFor(newState.guild.members.me);
      if (!permissions.has('Connect') || !permissions.has('Speak')) return;
      serverQueue.connection.destroy();
      const connection = joinVoiceChannel({ channelId: newState.channel.id, guildId: newState.guild.id, adapterCreator: newState.guild.voiceAdapterCreator });
      connection.subscribe(serverQueue.player);
      serverQueue.connection = connection;
    }
  }
});

// --- Login ---
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.TOKEN);





