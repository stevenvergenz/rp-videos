import * as google from 'googleapis';
import { resolve } from 'path';
import cbfs from 'fs';
import { promisify } from 'util';
const fs = {
	stat: promisify(cbfs.stat),
	read: promisify(cbfs.readFile),
	write: promisify(cbfs.writeFile)
};

const API_KEY = process.env['API_KEY'];

// list of youtube channels, sorted from high to low priority
const SourceYoutubeChannels = [
	// 'UC-r31xs58uQtLrpXDNazBpw', // stevenvergenz
	'UCtI0Hodo5o5dUb67FeUjDeA', // SpaceX
	'UCVxTHEKKLxNjGcvVaZindlg', // Blue Origin
	'UCRn9F2D9j-t4A-HgudM7aLQ', // Arianespace
	'UCsWq7LZaizhIi-c-Yo_bcpw', // Rocket Lab
	'UC6uKrU_WqJ1R2HMTY3LIx5Q', // Everyday Astronaut
	'UCnrGPRKAg1PgvuSHrRIl3jg', // ULA
	'UCLA_DiR1FfKNvjuUpBHmylQ', // NASA TV
];

const VidPriorities = new Map<RegExp, number>();
VidPriorities.set(/Mission Control Audio/, -1);
VidPriorities.set(/^NASA Live: Official Stream of NASA TV$/, 1);

export interface VideoDetails {
	index: number;
	id: string;
	url: string;
	name: string;
	thumbnailUrl: string;
	thumbnailRatio: number;
	live: boolean;
	startTime: number;
	priority?: number;
}

const CACHEPATH = process.env['CACHE_PATH'] || resolve(__dirname, '../db/cache.json');
const EXPIRY = 6 * 60 * 60 * 1000; // 8 hours in ms

export class ChannelManager {
	public videoDetails: VideoDetails[];

	public get liveVideos() {
		return this.videoDetails.filter(vd => vd.live);
	}

	public get highestPriorityStream() {
		return this.videoDetails.find(vd => vd.live);
	}

	public async refreshLiveStatus() {
		if (this.videoDetails.length === 0) return;
		const service = new google.youtube_v3.Youtube({ auth: API_KEY });
		const response = await service.videos.list({
			part: 'snippet,liveStreamingDetails',
			id: this.videoDetails.filter(vd => /^youtube:/.test(vd.url)).map(vd => vd.id).join(','),
			maxResults: this.videoDetails.length,
			key: API_KEY
		});

		const updates: { [id: string]: Partial<VideoDetails> } = {};
		for (const result of response.data.items) {
			updates[result.id] = {
				live: result.snippet.liveBroadcastContent === 'live',
				startTime: Date.parse(
					result.liveStreamingDetails.actualStartTime ||
					result.liveStreamingDetails.scheduledStartTime)
			};
		}
		const nowPlaying: string[] = [];
		for (const vid of this.videoDetails) {
			if (vid.live === false && updates[vid.id].live === true) {
				nowPlaying.push(vid.id);
			}
			Object.assign(vid, updates[vid.id]);
		}

		return nowPlaying;
	}

	public async updateVideoLinks(force = false) {
		if (!force) {
			this.videoDetails = await ChannelManager.getDataFromCache();
			if (this.videoDetails) {
				// fresh cache data found, use it
				return;
			}
		}

		this.videoDetails = await ChannelManager.getDataFromWeb();
		await this.refreshLiveStatus();
		ChannelManager.saveDataToCache(this.videoDetails);
	}

	private static async getDataFromCache(): Promise<VideoDetails[]> {
		try {
			const metadata = await fs.stat(CACHEPATH);
			if (metadata.mtimeMs < (Date.now() - EXPIRY)) {
				console.log('Cache is stale, refreshing');
				return null;
			}
		} catch (e) {
			// failed to fetch cache metadata
			const ex = e as NodeJS.ErrnoException;
			if (ex.code === 'ENOENT') {
				console.log('No cache data found, fetching from web');
			} else {
				console.error('Failed to read from cache:', ex);
			}
			return null;
		}

		const stringData = await fs.read(CACHEPATH, { encoding: 'utf8' });
		return JSON.parse(stringData) as VideoDetails[];
	}

	private static async saveDataToCache(videos: VideoDetails[]) {
		try {
			await fs.write(
				CACHEPATH,
				JSON.stringify(videos),
				{ encoding: 'utf8' }
			);
		}
		catch (e) {
			console.error('Failed to write to cache:', e);
		}
	}

	private static async getDataFromWeb(): Promise<VideoDetails[]> {
		const videoDetails: VideoDetails[] = [];

		// use manually provided video IDs instead of searching if provided
		if (process.env.VIDEO_URLS) {
			const urls = process.env.VIDEO_URLS.split(';');
			videoDetails.push(...urls.map((url, i) => {
				return {
					index: i,
					id: url,
					name: `Manual Video ${i}`,
					url,
					live: true
				} as VideoDetails;
			}));
		}

		const service = new google.youtube_v3.Youtube({ auth: API_KEY });
		for (const channelId of SourceYoutubeChannels) {
			const streams: google.youtube_v3.Schema$SearchResult[] = [];
			try {
				const liveStreams = await service.search.list({
					part: 'snippet',
					channelId,
					type: 'video',
					eventType: 'live',
					order: 'rating',
					relevanceLanguage: 'en',
					maxResults: 5,
					key: API_KEY
				});
				streams.push(...liveStreams.data.items);
				const upcomingStreams = await service.search.list({
					part: 'snippet',
					channelId,
					type: 'video',
					eventType: 'upcoming',
					order: 'rating',
					relevanceLanguage: 'en',
					maxResults: 5,
					key: API_KEY
				});
				streams.push(...upcomingStreams.data.items);
			} catch (e) {
				console.error(e);
			}

			videoDetails.push(
				...streams.map(result => {
					const deets = {
						id: result.id.videoId,
						name: result.snippet.title,
						url: `youtube://${result.id.videoId}`,
						thumbnailUrl: result.snippet.thumbnails.default.url,
						live: result.snippet.liveBroadcastContent === 'live',
						priority: 0
					} as VideoDetails;

					for (const [regex, pri] of VidPriorities.entries()) {
						if (regex.test(deets.name)) {
							deets.priority = pri;
						}
					}

					console.log('Found video', deets);
					return deets;
				})
				.sort((a, b) =>
					((b.priority || 0) - (a.priority || 0))
					|| a.name.localeCompare(b.name, "en-US", { sensitivity: 'base' })
				)
			);
		}
		videoDetails.forEach((vid, i) => vid.index = i);
		return videoDetails;
	}
}
