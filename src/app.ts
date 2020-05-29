/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as MRE from '@microsoft/mixed-reality-extension-sdk';
import { VideoPlayerManager } from '@microsoft/mixed-reality-extension-altspacevr-extras';

import { ChannelManager, VideoDetails } from './channelManager';

const UPDATE_TIMEOUT = 1 * 60 * 1000; // five minutes

/**
 * The main class of this app. All the logic goes here.
 */
export default class VideoManager {
	private assets: MRE.AssetContainer;
	private modsOnly: MRE.GroupMask;
	// private videoPlayerManager: VideoPlayerManager;
	private screen: MRE.Actor;
	private label: MRE.Actor;
	private hoverText: string;
	private volume = 0.2;
	private textureCache: { [url: string]: MRE.Texture } = {};
	private streamCache: { [url: string]: MRE.VideoStream } = {};

	private channels: ChannelManager;
	private channelButtonMesh: MRE.Mesh;
	private channelButtons: MRE.Actor[] = [];
	private currentVideo: VideoDetails;
	private currentVideoInstance: MRE.MediaInstance;

	private refreshInterval: NodeJS.Timeout;
	private timerInterval: NodeJS.Timeout;

	constructor(public context: MRE.Context, private params: MRE.ParameterSet, private baseUrl: string) {
		this.assets = new MRE.AssetContainer(context);
		// this.videoPlayerManager = new VideoPlayerManager(context);
		this.channels = new ChannelManager();
		this.context.onStarted(() => this.started());
		this.context.onUserJoined(user => this.onUserJoined(user));
		this.context.onStopped(() => this.stopped());
	}

	private async started() {
		this.screen = MRE.Actor.Create(this.context, {
			actor: {
				name: 'screen',
				transform: { local: { scale: { x: 3, y: 3, z: 3 } } }
			}
		});
		this.label = MRE.Actor.Create(this.context, {
			actor: {
				name: 'label',
				transform: { local: { position: { x: 0, y: -0.78, z: -0.05 } } },
				text: {
					contents: '',
					height: 0.1,
					anchor: MRE.TextAnchorLocation.MiddleCenter
				}
			}
		});
		MRE.Actor.Create(this.context, {
			actor: {
				transform: { local: { position: { x: 0, y: -1, z: -1 } } },
				light: {
					type: 'point',
					color: MRE.Color3.White(),
					range: 5,
					intensity: 1
				}
			}
		});
		this.modsOnly = new MRE.GroupMask(this.context, ['moderator']);
		this.createVolumeControls();

		this.playChannel(null);
		await this.channels.updateVideoLinks();
		this.updateUI();
		this.playChannel(this.channels.highestPriorityStream);

		this.refreshInterval = setInterval(async () => {
			const nowPlaying = await this.channels.refreshLiveStatus();
			this.updateUI(nowPlaying);
			if (this.currentVideo && !this.currentVideo.live && nowPlaying.includes(this.currentVideo.id)) {
				this.playChannel(this.channels.videoDetails.find(vd => vd.id === this.currentVideo.id));
			}
		}, UPDATE_TIMEOUT);
	}

	private onUserJoined(user: MRE.User) {
		if (/\bmoderator\b/.test(user.properties['altspacevr-roles'])) {
			user.groups.add('moderator');
		} else {
			user.groups.clear();
		}
	}

	private userIsMod(user: MRE.User) {
		return this.params.public || user.groups.has('moderator');
	}

	private stopped() {
		clearInterval(this.refreshInterval);
	}

	private createVolumeControls() {
		const buttonMesh = this.assets.createBoxMesh('volButton', 0.2, 0.15, 0.01);
		const label = MRE.Actor.Create(this.context, {
			actor: {
				name: 'volumeLabel',
				transform: { local: { position: { x: 1.7 } } },
				appearance: { enabled: this.modsOnly },
				text: {
					contents: `Volume:\n${Math.round(this.volume * 100)}%`,
					height: 0.07,
					anchor: MRE.TextAnchorLocation.MiddleCenter,
					justify: MRE.TextJustify.Center
				}
			}
		});

		const volUp = MRE.Actor.Create(this.context, {
			actor: {
				name: 'volUp',
				appearance: {
					enabled: this.modsOnly,
					meshId: buttonMesh.id
				},
				collider: { geometry: { shape: 'auto' } },
				transform: { local: { position: { x: 1.7, y: 0.18 } } }
			}
		});
		MRE.Actor.Create(this.context, {
			actor: {
				name: 'volUpLabel',
				parentId: volUp.id,
				transform: { local: { position: { z: -0.01 } } },
				text: {
					contents: '+',
					height: 0.1,
					anchor: MRE.TextAnchorLocation.MiddleCenter
				}
			}
		});

		const volDown = MRE.Actor.Create(this.context, {
			actor: {
				name: 'volDown',
				appearance: {
					enabled: this.modsOnly,
					meshId: buttonMesh.id
				},
				collider: { geometry: { shape: 'auto' } },
				transform: { local: { position: { x: 1.7, y: -0.18 } } }
			}
		});
		MRE.Actor.Create(this.context, {
			actor: {
				name: 'volDownLabel',
				parentId: volDown.id,
				transform: { local: { position: { z: -0.01 } } },
				text: {
					contents: '-',
					height: 0.1,
					anchor: MRE.TextAnchorLocation.MiddleCenter
				}
			}
		});

		volUp.setBehavior(MRE.ButtonBehavior).onButton('pressed', user => {
			if (!this.userIsMod(user)) return;
			this.volume = Math.min(this.volume + 0.1, 1);
			label.text.contents = `Volume:\n${Math.round(this.volume * 100)}%`;
			if (this.currentVideoInstance) {
				this.currentVideoInstance.setState({ volume: this.volume });
			}
		});

		volDown.setBehavior(MRE.ButtonBehavior).onButton('pressed', user => {
			if (!this.userIsMod(user)) return;
			this.volume = Math.max(this.volume - 0.1, 0);
			label.text.contents = `Volume:\n${Math.round(this.volume * 100)}%`;
			if (this.currentVideoInstance) {
				this.currentVideoInstance.setState({ volume: this.volume });
			}
		});
	}

	private updateUI(nowPlaying?: string[]) {
		if (this.channels.videoDetails.length === 0) {
			this.label.text.contents = "No livestreams found";
			return;
		}

		const buttonVids = this.channels.videoDetails.filter(vd => {
			const now = Date.now();
			const sixtyMinutes = 60 * 60 * 1000;
			return vd.live ||
				vd.startTime < (now + sixtyMinutes) && vd.startTime > (now - sixtyMinutes);
		});

		const buttonWidth = 0.4;
		const buttonGap = 0.05;
		const layoutWidth = (buttonVids.length - 1) * (buttonWidth + buttonGap);

		let bi = 0;
		let shouldChime = false;
		buttonVids.forEach((deets, i) => {
			let b = this.channelButtons[i];
			if (!this.channelButtons[i]) {
				this.channelButtons.push(b = this.createButton(i, deets.thumbnailUrl));
			} else {
				b.appearance.material.mainTexture = this.getOrLoadThumbnail(deets.thumbnailUrl);
			}

			const place = (-layoutWidth / 2) + i * (buttonWidth + buttonGap);
			b.transform.local.position = new MRE.Vector3(place, -1, 0);
			b.appearance.enabled = this.modsOnly;

			b.setBehavior(MRE.ButtonBehavior)
				.onHover('enter', user => {
					if (!this.userIsMod(user)) return;
					this.hoverText = deets.name;
					this.label.text.contents = this.hoverText;
				})
				.onHover('exit', user => {
					if (!this.userIsMod(user)) return;
					this.hoverText = null;
					this.label.text.contents = '';
				})
				.onClick(user => {
					if (!this.userIsMod(user)) return;
					console.log(`User ${user.name} changed the channel`);
					this.playChannel(deets);
					if (!deets.live) {
						this.timerInterval = setInterval(() => {
							const diff = (deets.startTime - Date.now()) / 1000;
							const countdownString =
								Math.floor(diff / 3600).toString() + ':' +
								Math.floor((diff % 3600) / 60).toString().padStart(2, '0') + ':' +
								Math.floor(diff % 60).toString().padStart(2, '0');
							this.label.text.contents = this.hoverText || countdownString;
						}, 1000);
					}
				});

			// flash if the channel is updated
			if (nowPlaying && nowPlaying.includes(deets.id)) {
				this.flashButton(b);
				shouldChime = shouldChime || this.currentVideo && i <= this.currentVideo.index;
			}

			bi = i + 1;
		});

		for (let i = bi; i < this.channelButtons.length; i++) {
			this.channelButtons[i].appearance.enabled = false;
			this.channelButtons[i].collider.enabled = false;
		}

		if (shouldChime) {
			const chime = this.getOrLoadSound(`${this.baseUrl}/notification.wav`);
			this.screen.startSound(chime.id, { looping: false, volume: 0.8 });
		}
	}

	private createButton(index: number, image: string, width = 0.4) {
		if (!this.channelButtonMesh) {
			this.channelButtonMesh = (new MRE.AssetContainer(this.context)).createBoxMesh(
				'channelButton', width, width * 0.75, 0.01
			);
		}
		return MRE.Actor.Create(this.context, {
			actor: {
				name: `Button ${index}`,
				appearance: {
					enabled: this.modsOnly,
					materialId: this.assets.createMaterial(
						`Button ${index}`, { mainTextureId: this.getOrLoadThumbnail(image).id }
					).id,
					meshId: this.channelButtonMesh.id
				},
				collider: { geometry: { shape: 'auto' } }
			}
		});
	}

	private flashButton(actor: MRE.Actor) {
		const origColor = actor.appearance.material.color.clone();
		const origTexture = actor.appearance.material.mainTexture;
		flash(5);

		function flash(numTimes: number) {
			if (numTimes <= 0) return;

			actor.appearance.material.color.set(1,1,1,1);
			actor.appearance.material.mainTexture = null;
			setTimeout(() => {
				actor.appearance.material.color.copy(origColor);
				actor.appearance.material.mainTexture = origTexture;
			}, 200);

			setTimeout(() => flash(numTimes - 1), 1000);
		}
	}

	private getOrLoadSound(uri: string): MRE.Sound {
		return this.assets.sounds.find(s => s.uri === uri) || this.assets.createSound(uri, { uri });
	}

	private getOrLoadThumbnail(url: string): MRE.Texture {
		return this.textureCache[url] ||
			(this.textureCache[url] = this.assets.createTexture(url, { uri: url }));
	}

	private getOrLoadStream(url: string): MRE.VideoStream {
		return this.streamCache[url] ||
			(this.streamCache[url] = this.assets.createVideoStream(url, { uri: url }));
	}

	private playChannel(vid: VideoDetails) {
		if (this.timerInterval) {
			clearInterval(this.timerInterval);
		}

		if (!vid || this.currentVideo && this.currentVideo.id === vid.id && this.currentVideo.live === vid.live) {
			this.currentVideo = null;
			// this.videoPlayerManager.stop(this.screen.id);
			if (this.currentVideoInstance) {
				this.currentVideoInstance.pause();
			}
		} else {
			this.currentVideo = { ...vid };
			// this.videoPlayerManager.play(this.screen.id, vid.url, 0);
			if (this.currentVideoInstance) {
				this.currentVideoInstance.stop();
			}
			this.currentVideoInstance = this.screen.startVideoStream(
				this.getOrLoadStream(vid.url).id,
				{ rolloffStartDistance: 5, volume: this.volume }
			);
		}
	}
}
