import * as achievement from '../../helpers/achievement';
import * as handler from '../../helpers/handler';
import type {Request as $Request, Response as $Response} from 'express';
import {
	fetchEntitiesForRelationships, fetchOrCreateMainEntity, getChangedProps,
	getNextRelationshipSets, indexAutoCreatedEditionGroup, saveEntitiesAndFinishRevision
} from './entity';
import type {
	EntityTypeString
} from 'bookbrainz-data/lib/func/types';
import {FormSubmissionError} from '../../../common/helpers/error';
import _ from 'lodash';
import {_bulkIndexEntities} from '../../../common/helpers/search';
import {transformNewForm as authorTransform} from './author';
import {transformNewForm as editionGroupTransform} from './edition-group';
import {transformNewForm as editionTransform} from './edition';
import log from 'log';
import {transformNewForm as publisherTransform} from './publisher';
import {transformNewForm as seriesTransform} from './series';
import {transformNewForm as workTransform} from './work';


type PassportRequest = $Request & {user: any, session: any};
const transformFunctions = {
	author: authorTransform,
	edition: editionTransform,
	editionGroup: editionGroupTransform,
	publisher: publisherTransform,
	series: seriesTransform,
	work: workTransform
};
const additionalEntityProps = {
	author: [
		'typeId', 'genderId', 'beginAreaId', 'beginDate', 'endDate', 'ended',
		'endAreaId'
	],
	edition: [
		'editionGroupBbid', 'width', 'height', 'depth', 'weight', 'pages',
		'formatId', 'statusId'
	],
	editionGroup: 'typeid',
	publisher: ['typeId', 'areaId', 'beginDate', 'endDate', 'ended'],
	series: ['entityType', 'orderingTypeId'],
	work: 'typeId'

};

const baseRelations = [
	'aliasSet.aliases.language',
	'annotation.lastRevision',
	'defaultAlias',
	'disambiguation',
	'identifierSet.identifiers.type',
	'relationshipSet.relationships.type',
	'revision.revision',
	'collections.owner'
];

const additionalEntityAttributes = {
	author: ['authorType', 'gender', 'beginArea', 'endArea'],
	edition: [
		'authorCredit.names.author.defaultAlias',
		'editionGroup.defaultAlias',
		'languageSet.languages',
		'editionFormat',
		'editionStatus',
		'releaseEventSet.releaseEvents',
		'publisherSet.publishers.defaultAlias'
	],
	editionGroup: [
		'authorCredit.names.author.defaultAlias',
		'editionGroupType',
		'editions.defaultAlias',
		'editions.disambiguation',
		'editions.releaseEventSet.releaseEvents',
		'editions.identifierSet.identifiers.type',
		'editions.editionFormat'
	],
	publisher: ['publisherType', 'area'],
	series: [
		'defaultAlias',
		'disambiguation',
		'seriesOrderingType',
		'identifierSet.identifiers.type'
	],
	work: ['workType', 'languageSet.languages']
};

export async function processAchievement(orm, editorId, entityJSON) {
	const {revisionId} = entityJSON;
	try {
		const achievementUnlock = await achievement.processEdit(orm, editorId, revisionId);
		if (achievementUnlock.alert) {
			entityJSON.alert = achievementUnlock.alert;
		}
		return entityJSON;
	}
	catch (err) {
		return Promise.reject(new Error(err));
	}
}

export function transformForm(body:Record<string, any>):Record<string, any> {
	const modifiedForm = {};
	for (const keyIndex in body) {
		if (Object.prototype.hasOwnProperty.call(body, keyIndex)) {
			const currentForm = body[keyIndex];
			const transformedForm = transformFunctions[_.camelCase(currentForm.type)](currentForm);
			modifiedForm[keyIndex] = {__isNew__: currentForm.__isNew__, id: currentForm.id, type: currentForm.type, ...transformedForm};
		}
	}
	return modifiedForm;
}


export async function handleAddRelationship(
	body:Record<string, any>,
	editorId:number,
	currentEntity,
	entityType:EntityTypeString,
	orm,
	transacting
) {
	const {Revision} = orm;

	// new revision for adding relationship
	const newRevision = await new Revision({
		authorId: editorId,
		isMerge: false
	}).save(null, {transacting});
	const relationshipSets = await getNextRelationshipSets(
		orm, transacting, currentEntity, body
	);
	if (_.isEmpty(relationshipSets)) {
		return {};
	}
	// Fetch main entity
	const mainEntity = await fetchOrCreateMainEntity(
		orm, transacting, false, currentEntity.bbid, entityType
	);

	// Fetch all entities that definitely exist
	const otherEntities = await fetchEntitiesForRelationships(
		orm, transacting, currentEntity, relationshipSets
	);
	otherEntities.forEach(entity => { entity.shouldInsert = false; });
	mainEntity.shouldInsert = false;
	const allEntities = [...otherEntities, mainEntity]
		.filter(entity => entity.get('dataId') !== null);
	_.forEach(allEntities, (entityModel) => {
		const bbid: string = entityModel.get('bbid');
		if (_.has(relationshipSets, bbid)) {
			entityModel.set(
				'relationshipSetId',
				// Set to relationshipSet id or null if empty set
				relationshipSets[bbid] && relationshipSets[bbid].get('id')
			);
		}
	});
	const savedMainEntity = await saveEntitiesAndFinishRevision(
		orm, transacting, false, newRevision, mainEntity, allEntities,
		editorId, body.note
	);
	return savedMainEntity.toJSON();
}

async function processRelationship(rels:Record<string, any>[], mainEntity, bbidMap:Record<string, any>, editorId:number, orm, transacting) {
	if (!_.isEmpty(rels)) {
		const relationships = rels.map((rel) => (
			{...rel, sourceBbid: _.get(bbidMap, rel.sourceBbid) ?? rel.sourceBbid,
			 targetBbid: _.get(bbidMap, rel.targetBbid) ?? rel.targetBbid}
		));
		const {relationshipSetId} = await handleAddRelationship({relationships}, editorId,
			 mainEntity, mainEntity.type, orm, transacting);
		mainEntity.relationshipSetId = relationshipSetId;
	}
}

function getEntityRelations(type:EntityTypeString) {
	return [...baseRelations, ...additionalEntityAttributes[_.camelCase(type)]];
}

export function handleCreateMultipleEntities(
	req: PassportRequest,
	res: $Response
) {
	const {orm}: {orm?: any} = req.app.locals;
	const {Entity, Revision, bookshelf} = orm;
	const editorJSON = req.user;

	const {body}: {body: Record<string, any>} = req;
	let currentEntity: {
		__isNew__: boolean | undefined,
		aliasSet: {id: number} | null | undefined,
		annotation: {id: number} | null | undefined,
		bbid: string,
		disambiguation: {id: number} | null | undefined,
		identifierSet: {id: number} | null | undefined,
		type: EntityTypeString
	} | null | undefined;

	const entityEditPromise = bookshelf.transaction(async (transacting) => {
		const savedMainEntities = {};
		// map dummy id to real bbid
		const bbidMap = {};
		const allRelationships = {};
		// callback for creating entity
		async function processEntity(entityKey:string) {
			const entityForm = body[entityKey];
			const entityType = _.upperFirst(entityForm.type);
			// edition entity should be on the bottom of the list
			if (entityType === 'Edition') {
				if (!_.isEmpty(entityForm.publishers)) {
					entityForm.publishers = entityForm.publishers.map((id) => bbidMap[id] ?? id);
				}
				if (entityForm.editionGroupBbid) {
					entityForm.editionGroupBbid = bbidMap[entityForm.editionGroupBbid] ?? entityForm.editionGroupBbid;
				}
				if (!_.isNil(entityForm.authorCredit)) {
					entityForm.authorCredit = entityForm.authorCredit.map(
						(credit) => ({...credit, authorBBID: bbidMap[credit.authorBBID] ?? credit.authorBBID})
					);
				}
			}
			allRelationships[entityKey] = entityForm.relationships;
			const isNew = _.get(entityForm, '__isNew__', true);
			if (isNew) {
				const newEntity = await new Entity({type: entityType}).save(null, {transacting});
				currentEntity = newEntity.toJSON();
			}
			else {
				currentEntity = await orm.func.entity.getEntity(orm, entityType, entityForm.id, getEntityRelations(entityType as EntityTypeString));
				if (!currentEntity) {
					throw new FormSubmissionError('Entity with given id not found');
				}
			}
			// create new revision for each entity
			const newRevision = await new Revision({
				authorId: editorJSON.id,
				isMerge: false
			}).save(null, {transacting});
			const additionalProps = _.pick(entityForm, additionalEntityProps[_.camelCase(entityType)]);
			const changedProps = await getChangedProps(
				orm, transacting, isNew, currentEntity, entityForm, entityType,
				newRevision, additionalProps
			);
			// If there are no differences, bail
			if (_.isEmpty(changedProps)) {
				throw new FormSubmissionError('No Updated Field');
			}
			const mainEntity = await fetchOrCreateMainEntity(
				orm, transacting, isNew, currentEntity.bbid, entityType
			);
			mainEntity.shouldInsert = isNew;

			// set changed attributes on main entity
			_.forOwn(changedProps, (value, key) => mainEntity.set(key, value));
			const savedMainEntity = await saveEntitiesAndFinishRevision(
				orm, transacting, isNew, newRevision, mainEntity, [mainEntity],
				editorJSON.id, entityForm.note
			);

			/* We need to load the aliases for search reindexing and refresh it*/
			await savedMainEntity.load('aliasSet.aliases', {transacting});

			/* New entities will lack some attributes like 'type' required for search indexing */
			await savedMainEntity.refresh({transacting});

			/* fetch and reindex EditionGroups that may have been created automatically by the ORM and not indexed */
			if (savedMainEntity.get('type') === 'Edition') {
				await indexAutoCreatedEditionGroup(orm, savedMainEntity, transacting);
			}
			bbidMap[entityKey] = savedMainEntity.get('bbid');
			savedMainEntities[entityKey] = savedMainEntity.toJSON();
			// getNextRelationshipSet expects relationshipSet.id to exist
			if (!isNew) {
				_.set(savedMainEntities[entityKey], ['relationshipSet', 'id'], savedMainEntities[entityKey].relationshipSetId);
			}
		}
		try {
			// bookshelf's transaction have issue with Promise.All, refer https://github.com/bookshelf/bookshelf/issues/1498 for more details
			await Object.keys(body).reduce((promise, entityKey) => promise.then(() => processEntity(entityKey)), Promise.resolve());

			// adding relationship on newly created entites
			await Object.keys(allRelationships).reduce((promise, entityId) => promise.then(() => processRelationship(
				allRelationships[entityId], savedMainEntities[entityId], bbidMap, editorJSON.id, orm, transacting
			)), Promise.resolve());

			return savedMainEntities;
		}
		catch (err) {
			log.error(err);
			throw err;
		}
	});
	const achievementPromise = entityEditPromise.then(
		(entitiesJSON:Record<string, any>) => {
			const entitiesAchievementsPromise = [];
			for (const entityJSON of Object.values(entitiesJSON)) {
				entitiesAchievementsPromise.push(processAchievement(orm, editorJSON.id, entityJSON));
			}
			return Promise.all(entitiesAchievementsPromise).catch(err => { throw err; });
		}
	);
	return handler.sendPromiseResult(
		res,
		achievementPromise,
		_bulkIndexEntities
	);
}
